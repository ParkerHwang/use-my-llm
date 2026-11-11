import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct BridgeCommand: Sendable {
    private let resources: URL
    private let node: URL
    private let entry: URL
    private let environment: [String: String]

    init?() {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let node = resources.appendingPathComponent("node")
        let entry = resources.appendingPathComponent("app/packages/bridge/dist/cli.mjs")
        let files = FileManager.default
        guard files.isExecutableFile(atPath: node.path), files.fileExists(atPath: entry.path) else { return nil }
        self.resources = resources
        self.node = node
        self.entry = entry
        let home = files.homeDirectoryForCurrentUser
        var environment = [
            "HOME": home.path,
            "PATH": "\(home.appendingPathComponent(".local/bin").path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": files.temporaryDirectory.path
        ]
        let local = ProcessInfo.processInfo.environment
        for key in ["LOCALHOSTAGENT_DATA_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
            environment[key] = local[key]
        }
        self.environment = environment
    }

    func process(arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = node
        process.arguments = [entry.path] + arguments
        process.currentDirectoryURL = resources
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.environment = environment
        return process
    }

    func context<Value: Decodable & Sendable>(_ arguments: [String]) async throws -> Value {
        try await Task.detached {
            let child = process(arguments: ["context"] + arguments + ["--json"])
            let output = Pipe()
            child.standardOutput = output
            try child.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            child.waitUntilExit()
            let decoder = JSONDecoder()
            if child.terminationStatus != 0 {
                throw (try? decoder.decode(CommandFailure.self, from: data).error)
                    ?? PickerError(message: "The context command failed.")
            }
            return try decoder.decode(Value.self, from: data)
        }.value
    }

    private struct CommandFailure: Decodable {
        let error: PickerError
    }
}

private struct PickerError: LocalizedError, Decodable {
    let message: String
    var errorDescription: String? { message }
}

private struct ContextSource: Decodable, Sendable, Identifiable {
    let ref: String
    let project: String
    let title: String
    let date: String?
    let kind: String
    let firstPrompt: String
    let preview: String
    var id: String { ref }
    var group: String { project.isEmpty ? "Other" : project }
}

private struct SourceList: Decodable, Sendable {
    let items: [ContextSource]
    let warnings: [String]
}

private struct SourcePreview: Decodable, Sendable {
    struct Message: Decodable, Sendable {
        let role: String
        let text: String
    }
    let messages: [Message]?
    let text: String?
    let forkProvider: String?
    var body: String {
        messages?.enumerated().map { "\($0.offset + 1). \($0.element.role.capitalized)\n\($0.element.text)" }
            .joined(separator: "\n\n") ?? text ?? ""
    }
}

private struct ShareReview: Decodable, Sendable {
    struct Plan: Decodable, Sendable {
        let kind: String
        let label: String
        let bytes: Int
        let redactions: Int
        let text: String
        let fingerprint: String
        let provider: String?
    }
    let plan: Plan
    let consent: [String]
}

private struct GrantList: Decodable, Sendable {
    struct Grant: Decodable, Identifiable, Sendable {
        struct Snapshot: Decodable, Identifiable, Sendable {
            let id: String
            let label: String
        }
        let origin: String
        let enabled: Bool
        let snapshots: [Snapshot]
        var id: String { origin }
    }
    let origins: [Grant]
}

private struct CommandResult: Decodable, Sendable {}

// Use the property wrapper on command-line toolchains without SwiftUI macro plugins.
private typealias ViewState<Value> = SwiftUI.State<Value>

struct ContextPicker: View {
    let command: BridgeCommand

    @ViewState private var app = "codex"
    @ViewState private var sources: [ContextSource] = []
    @ViewState private var selection: String?
    @ViewState private var preview: SourcePreview?
    @ViewState private var previewRef: String?
    @ViewState private var origin = ""
    @ViewState private var first = ""
    @ViewState private var last = ""
    @ViewState private var fork = false
    @ViewState private var listAcp = false
    @ViewState private var busy = false
    @ViewState private var status = ""
    @ViewState private var grants: [GrantList.Grant] = []
    @ViewState private var showGrants = false
    @ViewState private var review: ShareReview?
    @ViewState private var reviewArguments: [String] = []
    @ViewState private var reviewedOrigin = ""
    @ViewState private var revokeOrigin: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("App", selection: $app) {
                    Text("Codex").tag("codex")
                    Text("Claude Code").tag("claude-code")
                    Text("Claude Desktop").tag("claude-desktop")
                    Text("Antigravity").tag("antigravity")
                }.frame(width: 215)
                if app == "antigravity" {
                    Toggle("List ACP sessions", isOn: $listAcp)
                }
                if app == "claude-desktop" {
                    Button("Import Export ZIP…", action: importZip).disabled(busy)
                }
                Button("Refresh") { run { try await loadSources() } }.disabled(busy)
                Spacer()
                Button("Manage Sharing…") { run { try await loadGrants(); showGrants = true } }.disabled(busy)
            }
            HSplitView {
                sourceList.frame(minWidth: 260, idealWidth: 330)
                previewPane.frame(minWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack {
                TextField("Website origin", text: $origin, prompt: Text("https://example.com"))
                Button("Review Sharing…", action: reviewShare)
                    .disabled(busy || previewRef != selection || selection == nil || origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if !status.isEmpty { Text(status).foregroundStyle(.secondary).textSelection(.enabled) }
        }
        .padding(16)
        .frame(minWidth: 750, minHeight: 500)
        .task(id: app + String(app == "antigravity" && listAcp)) {
            do { try await loadSources() } catch is CancellationError {} catch { status = error.localizedDescription }
        }
        .task(id: selection) {
            preview = nil
            previewRef = nil
            first = ""
            last = ""
            fork = false
            guard let ref = selection else { return }
            if ref.hasPrefix("antigravity:acp:") { return }
            do {
                let value: SourcePreview = try await command.context(["preview", "--ref", ref])
                guard !Task.isCancelled, selection == ref else { return }
                preview = value
                previewRef = ref
            } catch {
                if !Task.isCancelled { status = error.localizedDescription }
            }
        }
        .sheet(isPresented: $showGrants) { grantsSheet }
        .sheet(isPresented: Binding(get: { review != nil }, set: { if !$0 { review = nil } })) {
            if let review { reviewSheet(review) }
        }
    }

    private var sourceList: some View {
        let grouped = Dictionary(grouping: sources, by: \.group)
        return List(selection: $selection) {
            ForEach(grouped.keys.sorted(), id: \.self) { project in
                Section(project) {
                    ForEach(grouped[project] ?? []) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.title).lineLimit(1)
                            Text([item.kind.capitalized, item.date.map { String($0.prefix(10)) } ?? ""]
                                .filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            if !item.firstPrompt.isEmpty {
                                Text(item.firstPrompt).font(.caption).lineLimit(2)
                            }
                        }
                        .tag(item.ref)
                    }
                }
            }
        }
        .accessibilityLabel("Local items")
    }

    private var previewPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Preview").font(.headline)
            ScrollView {
                Text(preview?.body ?? sources.first(where: { $0.ref == selection })?.preview ?? "Choose a local item.")
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let messages = preview?.messages, !messages.isEmpty, !fork {
                HStack {
                    Text("Messages")
                    TextField("From", text: $first, prompt: Text("1")).frame(width: 65)
                    Text("to")
                    TextField("To", text: $last, prompt: Text(String(messages.count))).frame(width: 65)
                    Text("of \(messages.count)").foregroundStyle(.secondary)
                }
            }
            if preview?.forkProvider != nil {
                Toggle("Continue the whole conversation as a copy", isOn: $fork)
            }
        }.padding(.leading, 12)
    }

    private func loadSources() async throws {
        let selectedApp = app
        let acp = selectedApp == "antigravity" && listAcp
        sources = []
        selection = nil
        status = "Loading local items…"
        let listing: SourceList = try await command.context(
            ["sources", "--app", selectedApp] + (acp ? ["--antigravity-acp"] : [])
        )
        try Task.checkCancellation()
        guard selectedApp == app, acp == (app == "antigravity" && listAcp) else { return }
        sources = listing.items
        status = listing.warnings.joined(separator: " ")
        if sources.isEmpty && status.isEmpty { status = "No local items found for this app." }
    }

    private func reviewShare() {
        guard let selection, previewRef == selection else {
            status = "Wait for the preview to load."
            return
        }
        let target = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        var args = ["--origin", target, "--ref", selection]
        if fork { args.append("--fork") }
        else {
            if !first.isEmpty { args += ["--from", first] }
            if !last.isEmpty { args += ["--to", last] }
        }
        run {
            let result: ShareReview = try await command.context(["plan"] + args)
            reviewedOrigin = target
            reviewArguments = args
            review = result
        }
    }

    private func reviewSheet(_ review: ShareReview) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Share with \(reviewedOrigin)").font(.title2)
            Text(review.plan.label)
            if review.plan.kind == "fork" {
                Text("This website can ask \(review.plan.provider ?? "the provider") to continue the conversation.")
                if review.plan.provider == "claude" { Text("Claude continuation requires a locally configured Anthropic API key.") }
                if review.plan.provider == "antigravity" { Text("Experimental ACP can run Antigravity’s tools and may retain the new session.") }
            }
            if !review.plan.text.isEmpty {
                Text("\(review.plan.bytes) bytes · \(review.plan.redactions) redactions").font(.caption)
                ScrollView {
                    Text(review.plan.text).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 100, idealHeight: 250)
            }
            ForEach(review.consent, id: \.self) { Text($0) }
            HStack {
                Spacer()
                Button("Cancel") { self.review = nil }.keyboardShortcut(.cancelAction)
                Button("Share") {
                    let arguments = reviewArguments
                    let target = reviewedOrigin
                    self.review = nil
                    run {
                        let _: CommandResult = try await command.context(
                            ["share"] + arguments + ["--expect", review.plan.fingerprint, "--yes"]
                        )
                        status = "Shared with \(target)."
                    }
                }
            }
        }.padding(20).frame(width: 560)
    }

    private var grantsSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Manage Sharing").font(.title2)
            if grants.isEmpty { Text("No websites have shared context.") }
            else {
                List(grants) { grant in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(grant.origin).font(.headline)
                            if !grant.enabled { Text("Sharing off").foregroundStyle(.secondary) }
                            Spacer()
                            Button("Revoke…") { revokeOrigin = grant.origin }
                        }
                        ForEach(grant.snapshots) { Text($0.label).font(.caption) }
                    }.padding(.vertical, 4)
                }.frame(minHeight: 180)
            }
            if !status.isEmpty { Text(status).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button("Done") { showGrants = false }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(20).frame(width: 520)
        .alert("Revoke shared context?", isPresented: Binding(get: { revokeOrigin != nil }, set: { if !$0 { revokeOrigin = nil } }), presenting: revokeOrigin) { target in
            Button("Cancel", role: .cancel) {}
            Button("Revoke", role: .destructive) {
                run {
                    let _: CommandResult = try await command.context(["revoke", "--origin", target])
                    try await loadGrants()
                    status = "Revoked sharing with \(target)."
                }
            }
        } message: { target in
            Text("Remove the snapshots and local conversation copies shared with \(target).")
        }
    }

    private func loadGrants() async throws {
        let value: GrantList = try await command.context(["grants"])
        grants = value.origins
    }

    private func importZip() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        run {
            let _: CommandResult = try await command.context(["import-claude-export", "--file", url.path])
            try await loadSources()
            status = "Claude export imported. Select an item to review sharing."
        }
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        status = ""
        Task { @MainActor in
            defer { busy = false }
            do { try await action() } catch { status = error.localizedDescription }
        }
    }
}
