import Foundation

public enum TerminalColor: Sendable, Equatable, Hashable {
    case `default`
    case ansi(UInt8)
    case palette(UInt8)
    case rgb(UInt8, UInt8, UInt8)
}

public struct TerminalCellStyle: Sendable, Equatable, Hashable {
    public var foreground: TerminalColor
    public var background: TerminalColor
    public var bold: Bool
    public var dim: Bool
    public var underline: Bool
    public var inverse: Bool

    public static let plain = TerminalCellStyle(
        foreground: .default,
        background: .default,
        bold: false,
        dim: false,
        underline: false,
        inverse: false
    )

    public init(
        foreground: TerminalColor = .default,
        background: TerminalColor = .default,
        bold: Bool = false,
        dim: Bool = false,
        underline: Bool = false,
        inverse: Bool = false
    ) {
        self.foreground = foreground
        self.background = background
        self.bold = bold
        self.dim = dim
        self.underline = underline
        self.inverse = inverse
    }
}

public struct TerminalRun: Sendable, Equatable {
    public let text: String
    public let style: TerminalCellStyle

    public init(text: String, style: TerminalCellStyle) {
        self.text = text
        self.style = style
    }
}

public struct TerminalRenderLine: Sendable, Equatable, Identifiable {
    public let id: Int
    public let runs: [TerminalRun]

    public var plainText: String {
        runs.map(\.text).joined()
    }

    public init(id: Int, runs: [TerminalRun]) {
        self.id = id
        self.runs = runs
    }
}

public protocol TerminalSurfaceProtocol: Sendable {
    var cols: Int { get }
    var rows: Int { get }
    var cursorRow: Int { get }
    var cursorCol: Int { get }
    var scrollbackCount: Int { get }
    mutating func feed(_ data: Data)
    mutating func resize(cols: Int, rows: Int)
    mutating func clear()
    func snapshotLines(includeScrollback: Bool) -> [TerminalRenderLine]
    func plainText() -> String
}

public struct VT100Emulator: TerminalSurfaceProtocol, Sendable {
    private struct Cell: Sendable, Equatable {
        var char: Character
        var style: TerminalCellStyle
        static let blank = Cell(char: " ", style: .plain)
    }

    private enum ParseState: Sendable {
        case ground
        case escape
        case csi(String)
        case osc
        case oscEsc
    }

    public private(set) var cols: Int
    public private(set) var rows: Int
    public private(set) var cursorRow: Int = 0
    public private(set) var cursorCol: Int = 0
    public var scrollbackCount: Int { scrollback.count }

    private let maxScrollback: Int
    private var grid: [[Cell]]
    private var scrollback: [[Cell]] = []
    private var style: TerminalCellStyle = .plain
    private var parseState: ParseState = .ground
    private var pendingUTF8: Data = Data()

    public init(cols: Int = 100, rows: Int = 30, maxScrollback: Int = 2000) {
        self.cols = max(8, cols)
        self.rows = max(2, rows)
        self.maxScrollback = max(100, maxScrollback)
        self.grid = Array(
            repeating: Array(repeating: Cell.blank, count: self.cols),
            count: self.rows
        )
    }

    public mutating func clear() {
        grid = Array(repeating: Array(repeating: Cell.blank, count: cols), count: rows)
        scrollback.removeAll(keepingCapacity: true)
        cursorRow = 0
        cursorCol = 0
        style = .plain
        parseState = .ground
        pendingUTF8.removeAll(keepingCapacity: true)
    }

    public mutating func resize(cols newCols: Int, rows newRows: Int) {
        let targetCols = max(8, newCols)
        let targetRows = max(2, newRows)
        guard targetCols != cols || targetRows != rows else { return }

        var nextGrid = Array(
            repeating: Array(repeating: Cell.blank, count: targetCols),
            count: targetRows
        )
        let copyRows = min(rows, targetRows)
        let copyCols = min(cols, targetCols)
        for r in 0..<copyRows {
            for c in 0..<copyCols {
                nextGrid[r][c] = grid[r][c]
            }
        }
        grid = nextGrid
        cols = targetCols
        rows = targetRows
        cursorRow = min(cursorRow, rows - 1)
        cursorCol = min(cursorCol, cols - 1)
    }

    public mutating func feed(_ data: Data) {
        guard !data.isEmpty else { return }
        pendingUTF8.append(data)
        let decoded = decodeValidUTF8Prefix(&pendingUTF8)
        for scalar in decoded.unicodeScalars {
            processScalar(scalar)
        }
    }

    public mutating func feedText(_ text: String) {
        feed(Data(text.utf8))
    }

    public func snapshotLines(includeScrollback: Bool = true) -> [TerminalRenderLine] {
        var allRows: [[Cell]] = []
        if includeScrollback {
            allRows.append(contentsOf: scrollback)
        }
        allRows.append(contentsOf: grid)

        var lastNonEmpty = scrollback.count + cursorRow
        for idx in stride(from: allRows.count - 1, through: 0, by: -1) {
            if allRows[idx].contains(where: { $0.char != " " || $0.style != .plain }) {
                lastNonEmpty = max(lastNonEmpty, idx)
                break
            }
        }
        let endIdx = min(allRows.count - 1, lastNonEmpty)
        guard endIdx >= 0 else { return [] }

        var result: [TerminalRenderLine] = []
        result.reserveCapacity(endIdx + 1)
        for idx in 0...endIdx {
            result.append(TerminalRenderLine(id: idx, runs: compressRuns(allRows[idx])))
        }
        return result
    }

    public func plainText() -> String {
        snapshotLines(includeScrollback: true)
            .map { $0.plainText.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) }
            .joined(separator: "\n")
    }

    private func decodeValidUTF8Prefix(_ buffer: inout Data) -> String {
        if let str = String(data: buffer, encoding: .utf8) {
            buffer.removeAll(keepingCapacity: true)
            return str
        }
        for trim in 1...min(3, buffer.count) {
            let prefix = buffer.prefix(buffer.count - trim)
            if let str = String(data: prefix, encoding: .utf8) {
                buffer = Data(buffer.suffix(trim))
                return str
            }
        }
        let lossy = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        return lossy
    }

    private mutating func processScalar(_ scalar: UnicodeScalar) {
        let value = scalar.value
        switch parseState {
        case .ground:
            switch value {
            case 0x1B:
                parseState = .escape
            case 0x0D:
                cursorCol = 0
            case 0x0A:
                lineFeed()
            case 0x08:
                cursorCol = max(0, cursorCol - 1)
            case 0x09:
                let nextTab = ((cursorCol / 8) + 1) * 8
                cursorCol = min(cols - 1, nextTab)
            case 0x07:
                break
            default:
                if value >= 0x20 {
                    putCharacter(Character(scalar))
                }
            }

        case .escape:
            switch scalar {
            case "[":
                parseState = .csi("")
            case "]":
                parseState = .osc
            case "c":
                clear()
            case "M":
                if cursorRow > 0 { cursorRow -= 1 }
                parseState = .ground
            default:
                parseState = .ground
            }

        case .csi(var params):
            if value >= 0x40 && value <= 0x7E {
                executeCSI(params: params, final: scalar)
                parseState = .ground
            } else {
                params.unicodeScalars.append(scalar)
                parseState = .csi(params)
            }

        case .osc:
            if value == 0x07 {
                parseState = .ground
            } else if value == 0x1B {
                parseState = .oscEsc
            }

        case .oscEsc:
            parseState = (scalar == "\\") ? .ground : .osc
        }
    }

    private mutating func putCharacter(_ ch: Character) {
        if cursorCol >= cols {
            cursorCol = 0
            lineFeed()
        }
        grid[cursorRow][cursorCol] = Cell(char: ch, style: style)
        cursorCol += 1
    }

    private mutating func lineFeed() {
        if cursorRow + 1 < rows {
            cursorRow += 1
        } else {
            let scrolled = grid.removeFirst()
            scrollback.append(scrolled)
            if scrollback.count > maxScrollback {
                scrollback.removeFirst(scrollback.count - maxScrollback)
            }
            grid.append(Array(repeating: Cell.blank, count: cols))
        }
    }

    private mutating func executeCSI(params raw: String, final: UnicodeScalar) {
        if raw.hasPrefix("?") || raw.hasPrefix(">") {
            return
        }
        let nums: [Int] = raw.isEmpty
            ? []
            : raw.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }

        func param(_ index: Int, default def: Int) -> Int {
            guard index < nums.count else { return def }
            return nums[index] == 0 ? def : nums[index]
        }

        switch final {
        case "A":
            cursorRow = max(0, cursorRow - param(0, default: 1))
        case "B":
            cursorRow = min(rows - 1, cursorRow + param(0, default: 1))
        case "C":
            cursorCol = min(cols - 1, cursorCol + param(0, default: 1))
        case "D":
            cursorCol = max(0, cursorCol - param(0, default: 1))
        case "G":
            cursorCol = max(0, min(cols - 1, param(0, default: 1) - 1))
        case "H", "f":
            let r = max(1, param(0, default: 1)) - 1
            let c = max(1, param(1, default: 1)) - 1
            cursorRow = min(rows - 1, r)
            cursorCol = min(cols - 1, c)
        case "J":
            let mode = nums.first ?? 0
            switch mode {
            case 2, 3:
                for r in 0..<rows {
                    grid[r] = Array(repeating: Cell.blank, count: cols)
                }
                if mode == 3 { scrollback.removeAll(keepingCapacity: true) }
            case 1:
                for r in 0..<cursorRow {
                    grid[r] = Array(repeating: Cell.blank, count: cols)
                }
                for c in 0...min(cursorCol, cols - 1) {
                    grid[cursorRow][c] = .blank
                }
            default:
                for c in min(cursorCol, cols - 1)..<cols {
                    grid[cursorRow][c] = .blank
                }
                if cursorRow + 1 < rows {
                    for r in (cursorRow + 1)..<rows {
                        grid[r] = Array(repeating: Cell.blank, count: cols)
                    }
                }
            }
        case "K":
            let mode = nums.first ?? 0
            switch mode {
            case 2:
                grid[cursorRow] = Array(repeating: Cell.blank, count: cols)
            case 1:
                for c in 0...min(cursorCol, cols - 1) {
                    grid[cursorRow][c] = .blank
                }
            default:
                for c in min(cursorCol, cols - 1)..<cols {
                    grid[cursorRow][c] = .blank
                }
            }
        case "m":
            applySGR(nums.isEmpty ? [0] : nums)
        default:
            break
        }
    }

    private mutating func applySGR(_ codes: [Int]) {
        var i = 0
        while i < codes.count {
            let code = codes[i]
            switch code {
            case 0:
                style = .plain
            case 1:
                style.bold = true
            case 2:
                style.dim = true
            case 4:
                style.underline = true
            case 7:
                style.inverse = true
            case 22:
                style.bold = false
                style.dim = false
            case 24:
                style.underline = false
            case 27:
                style.inverse = false
            case 30...37:
                style.foreground = .ansi(UInt8(code - 30))
            case 39:
                style.foreground = .default
            case 40...47:
                style.background = .ansi(UInt8(code - 40))
            case 49:
                style.background = .default
            case 90...97:
                style.foreground = .ansi(UInt8(code - 90 + 8))
            case 100...107:
                style.background = .ansi(UInt8(code - 100 + 8))
            case 38, 48:
                let isFg = (code == 38)
                if i + 2 < codes.count, codes[i + 1] == 5 {
                    let idx = UInt8(clamping: codes[i + 2])
                    if isFg { style.foreground = .palette(idx) } else { style.background = .palette(idx) }
                    i += 2
                } else if i + 4 < codes.count, codes[i + 1] == 2 {
                    let r = UInt8(clamping: codes[i + 2])
                    let g = UInt8(clamping: codes[i + 3])
                    let b = UInt8(clamping: codes[i + 4])
                    if isFg { style.foreground = .rgb(r, g, b) } else { style.background = .rgb(r, g, b) }
                    i += 4
                }
            default:
                break
            }
            i += 1
        }
    }

    private func compressRuns(_ row: [Cell]) -> [TerminalRun] {
        var lastContent = row.count - 1
        while lastContent >= 0 && row[lastContent].char == " " && row[lastContent].style == .plain {
            lastContent -= 1
        }
        guard lastContent >= 0 else {
            return [TerminalRun(text: "", style: .plain)]
        }

        var runs: [TerminalRun] = []
        var currentStyle = row[0].style
        var buffer = String(row[0].char)

        if lastContent >= 1 {
            for idx in 1...lastContent {
                let cell = row[idx]
                if cell.style == currentStyle {
                    buffer.append(cell.char)
                } else {
                    runs.append(TerminalRun(text: buffer, style: currentStyle))
                    currentStyle = cell.style
                    buffer = String(cell.char)
                }
            }
        }
        runs.append(TerminalRun(text: buffer, style: currentStyle))
        return runs
    }
}
