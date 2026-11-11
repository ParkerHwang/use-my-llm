import AppKit
import Darwin
import Foundation

final class BridgeApp: NSObject, NSApplicationDelegate {
    private enum State {
        case starting, running
        case stopped(String)
    }

    private static let bridgePort = 43189
    private static let readyLine = "LOCALHOST_AGENT_READY http://127.0.0.1:\(BridgeApp.bridgePort)"
    private static let startupOutputLimit = 4_096

    private var state: State = .starting
    private var statusItem: NSStatusItem?
    private let statusLabel = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let startItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var child: Process?
    private var outputPipe: Pipe?
    private var startupOutput = Data()
    private var startupTimeout: DispatchWorkItem?
    private var isInstalling = true
    private var isQuitting = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURL(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        installOrStart()
    }

    private func configureMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item

        let menu = NSMenu()
        menu.autoenablesItems = false
        statusLabel.isEnabled = false
        menu.addItem(statusLabel)
        menu.addItem(.separator())
        startItem.title = "Start Bridge"
        startItem.target = self
        startItem.action = #selector(startBridge)
        menu.addItem(startItem)
        let quitItem = NSMenuItem(title: "Quit use-my-llm", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        item.menu = menu
        updateMenu()
    }

    private func updateMenu() {
        let title: String
        switch state {
        case .starting:
            title = "use-my-llm …"
            statusLabel.title = "Starting the local bridge…"
        case .running:
            title = "use-my-llm"
            statusLabel.title = "Bridge running on 127.0.0.1:\(Self.bridgePort)"
        case .stopped(let reason):
            title = "use-my-llm (stopped)"
            statusLabel.title = reason
        }
        statusItem?.button?.title = title
        statusItem?.button?.toolTip = statusLabel.title
        startItem.isEnabled = !isInstalling && !isQuitting && child == nil
    }

    private func installOrStart() {
        let files = FileManager.default
        let source = Bundle.main.bundleURL.standardizedFileURL
        let applications = files.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)
        let installed = applications.appendingPathComponent("use-my-llm.app", isDirectory: true)
        let isInApplications = source.deletingLastPathComponent() == URL(fileURLWithPath: "/Applications", isDirectory: true)
        if source != installed.standardizedFileURL && !isInApplications && !files.fileExists(atPath: installed.path) {
            do {
                try files.createDirectory(at: applications, withIntermediateDirectories: true)
                let staging = applications.appendingPathComponent(".use-my-llm-\(UUID().uuidString).app", isDirectory: true)
                defer { try? files.removeItem(at: staging) }
                try files.copyItem(at: source, to: staging)
                try files.moveItem(at: staging, to: installed)

                let configuration = NSWorkspace.OpenConfiguration()
                configuration.createsNewApplicationInstance = true
                configuration.activates = false
                NSWorkspace.shared.openApplication(at: installed, configuration: configuration) { [weak self] application, error in
                    DispatchQueue.main.async {
                        guard let self else { return }
                        if error == nil, let application,
                           application.processIdentifier != ProcessInfo.processInfo.processIdentifier {
                            NSApp.terminate(nil)
                        } else {
                            self.isInstalling = false
                            self.startBridge()
                        }
                    }
                }
                return
            } catch {
                // The downloaded copy can run if the user's Applications folder is unavailable.
            }
        }
        isInstalling = false
        startBridge()
    }

    @objc private func handleURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let value = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URLComponents(string: value),
              url.scheme == "localhostagent", url.host == "start", url.path.isEmpty,
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else { return }
        DispatchQueue.main.async { [weak self] in self?.startBridge() }
    }

    @objc private func startBridge() {
        guard !isInstalling, !isQuitting, child == nil else { return }
        guard let resources = Bundle.main.resourceURL else {
            state = .stopped("The app bundle is missing its resources.")
            updateMenu()
            return
        }
        let node = resources.appendingPathComponent("node")
        let entry = resources.appendingPathComponent("app/packages/bridge/dist/cli.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            state = .stopped("The app bundle is missing the bridge or Node runtime.")
            updateMenu()
            return
        }

        let process = Process()
        let pipe = Pipe()
        process.executableURL = node
        process.arguments = [entry.path]
        process.currentDirectoryURL = resources
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        let home = FileManager.default.homeDirectoryForCurrentUser
        process.environment = [
            "HOME": home.path,
            "PATH": "\(home.appendingPathComponent(".local/bin").path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": FileManager.default.temporaryDirectory.path
        ]
        pipe.fileHandleForReading.readabilityHandler = { [weak self, weak process] handle in
            let data = handle.availableData
            guard !data.isEmpty, let process else {
                handle.readabilityHandler = nil
                return
            }
            let chunk = Data(data.prefix(Self.startupOutputLimit + 1))
            DispatchQueue.main.async { self?.handleStartupOutput(chunk, from: process) }
        }
        process.terminationHandler = { [weak self] completed in
            DispatchQueue.main.async { self?.childDidExit(completed) }
        }

        child = process
        outputPipe = pipe
        startupOutput.removeAll(keepingCapacity: true)
        state = .starting
        updateMenu()
        do {
            try process.run()
        } catch {
            releaseChild()
            state = .stopped("The bundled Node runtime could not start.")
            updateMenu()
            return
        }
        let timeout = DispatchWorkItem { [weak self, weak process] in
            guard let self, let process, self.child === process, case .starting = self.state else { return }
            self.failStartup("The bridge did not report readiness. Check port \(Self.bridgePort).", process: process)
        }
        startupTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: timeout)
    }

    private func handleStartupOutput(_ data: Data, from process: Process) {
        guard child === process, case .starting = state, !isQuitting else { return }
        guard startupOutput.count + data.count <= Self.startupOutputLimit else {
            failStartup("The bridge did not return a valid startup response.", process: process)
            return
        }
        startupOutput.append(data)
        while let newline = startupOutput.firstIndex(of: 0x0A) {
            let line = String(decoding: startupOutput[..<newline], as: UTF8.self)
            startupOutput.removeSubrange(...newline)
            if line == Self.readyLine, process.isRunning {
                startupTimeout?.cancel()
                startupTimeout = nil
                startupOutput.removeAll()
                state = .running
                updateMenu()
                return
            }
        }
    }

    private func failStartup(_ reason: String, process: Process) {
        startupTimeout?.cancel()
        startupTimeout = nil
        state = .stopped(reason)
        updateMenu()
        stop(process)
    }

    private func releaseChild() {
        startupTimeout?.cancel()
        startupTimeout = nil
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        startupOutput.removeAll()
        child = nil
    }

    private func childDidExit(_ process: Process) {
        guard child === process else { return }
        releaseChild()
        if isQuitting {
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        switch state {
        case .starting:
            state = .stopped("The bridge exited during startup. Check port \(Self.bridgePort).")
        case .running:
            state = .stopped("The local bridge stopped.")
        case .stopped:
            break
        }
        updateMenu()
    }

    private func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self, weak process] in
            guard let self, let process, self.child === process, process.isRunning else { return }
            kill(process.processIdentifier, SIGKILL)
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if isQuitting { return .terminateLater }
        guard let process = child, process.isRunning else { return .terminateNow }
        isQuitting = true
        startupTimeout?.cancel()
        updateMenu()
        stop(process)
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = BridgeApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
