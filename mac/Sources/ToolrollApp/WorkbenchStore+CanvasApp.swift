import Foundation
import ToolrollCore

extension WorkbenchStore {
    var webOriginY: Double {
        canvasAppSections.isEmpty ? 56 : 56 + Self.sectionHeaderBand
    }

    static let sectionHeaderBand: Double = 64
    static let sectionGap: Double = 96

    func canvasSectionTop(_ sectionId: String) -> Double {
        if sectionId == "web" { return 56 }
        return canvasAppArtboards.filter { $0.surface == sectionId }.map(\.y).min().map { $0 - Self.sectionHeaderBand } ?? 56
    }

    func canvasSectionWidth(_ sectionId: String) -> Double {
        let boards = sectionId == "web" ? canvasArtboards : canvasAppArtboards.filter { $0.surface == sectionId }
        let right = boards.map { $0.x + $0.width }.max() ?? 0
        let left = boards.map(\.x).min() ?? 60
        return max(720, right - left)
    }

    nonisolated static func readAppSections(projectRoot: String) -> [CanvasAppSection] {
        guard let manifest = AppSurfaceStorage.loadManifest(projectRoot: projectRoot) else { return [] }
        return manifest.surfaces.map { surface in
            let key = AppSurfaceStorage.surfaceStateKey(projectRoot: projectRoot,
                                                        pathspecs: AppSurfaceStorage.pathspecs(including: surface.paths))
            return CanvasAppSection(surface: surface, stateKey: key,
                                    captures: AppSurfaceStorage.latestCaptures(projectRoot: projectRoot, surface: surface.id, stateKey: key))
        }
    }

    func layoutCanvasAppArtboards() {
        let webBottom = canvasArtboards.map { $0.y + $0.height }.max() ?? 56
        var top = webBottom + Self.sectionGap
        var boards: [CanvasArtboard] = []
        for section in canvasAppSections {
            let laid = AppSurfaceStorage.layoutAppArtboards(surface: section.surface, captures: section.captures,
                                                            originY: top + Self.sectionHeaderBand)
            boards.append(contentsOf: laid)
            top = (laid.map { $0.y + $0.height }.max() ?? top) + Self.sectionGap
        }
        canvasAppArtboards = boards
    }

    func moveCanvasAppArtboard(id: String, dx: Double, dy: Double) {
        guard let idx = canvasAppArtboards.firstIndex(where: { $0.id == id }) else { return }
        canvasAppArtboards[idx].x += dx
        canvasAppArtboards[idx].y += dy
    }

    func canvasPins(onApp board: CanvasArtboard) -> [CanvasPin] {
        canvasPins.filter { $0.isAppPin && $0.surface == board.surface && $0.artboardPath == board.path && $0.appearance == board.appearance }
    }

    func reloadCanvasAppSections() async {
        guard let root = canvasProjectRoot else { return }
        let sections = await Task.detached(priority: .userInitiated) { Self.readAppSections(projectRoot: root) }.value
        guard canvasProjectRoot == root else { return }
        canvasAppSections = sections
        layoutCanvasAppArtboards()
    }

    func recaptureAppSurface(_ surfaceId: String) async {
        guard let root = canvasProjectRoot,
              let section = canvasAppSections.first(where: { $0.id == surfaceId }),
              canvasAppCaptureRuns[surfaceId]?.isRunning != true
        else { return }
        guard let script = AppCaptureRunner.scriptPath(projectRoot: root, relative: section.surface.capture) else {
            canvasAppCaptureRuns[surfaceId] = .failed(reason: "\(section.surface.capture) isn't a file in this project.", log: "")
            return
        }
        canvasAppCaptureRuns[surfaceId] = .running(progress: "Starting…")
        let key = await Task.detached(priority: .userInitiated) {
            AppSurfaceStorage.surfaceStateKey(projectRoot: root, pathspecs: AppSurfaceStorage.pathspecs(including: section.surface.paths))
        }.value
        let cacheDir = AppSurfaceStorage.surfaceCacheDir(projectRoot: root, surface: surfaceId).path
        let arguments = ["--repo", root, "--surface", surfaceId, "--state-key", key, "--cache-dir", cacheDir]
        let outcome = await AppCaptureRunner().run(script: script, arguments: arguments, cwd: root) { [weak self] line in
            guard case .progress(let words) = line else { return }
            Task { @MainActor in
                guard let self, self.canvasAppCaptureRuns[surfaceId]?.isRunning == true else { return }
                self.canvasAppCaptureRuns[surfaceId] = .running(progress: words)
            }
        }
        guard canvasProjectRoot == root else { return }
        if outcome.status == 0 {
            canvasAppCaptureRuns[surfaceId] = .idle
            await reloadCanvasAppSections()
            let count = canvasAppSections.first(where: { $0.id == surfaceId })?.captures?.index.captures.count ?? 0
            notice = WorkbenchNotice(kind: .info, message: "Captured \(count) \(section.title) screens.")
        } else {
            let reason = outcome.error ?? outcome.tail.last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? "The capture script stopped (exit \(outcome.status))."
            canvasAppCaptureRuns[surfaceId] = .failed(reason: reason, log: outcome.tail.suffix(20).joined(separator: "\n"))
        }
    }

    func dismissAppCaptureFailure(_ surfaceId: String) {
        if case .failed = canvasAppCaptureRuns[surfaceId] { canvasAppCaptureRuns[surfaceId] = .idle }
    }
}
