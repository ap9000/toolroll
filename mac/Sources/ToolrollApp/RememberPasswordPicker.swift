import SwiftUI
import ToolrollCore

/// Settings row: how long a typed or Touch ID password is remembered.
struct RememberPasswordPicker: View {
    let memory: PasswordMemory
    @State private var window: PasswordMemory.Window = PasswordMemory.defaultWindow

    var body: some View {
        Picker("Remember password for", selection: $window) {
            ForEach(PasswordMemory.Window.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.menu)
        .font(.system(size: 12))
        .fixedSize()
        .onAppear { window = memory.window }
        .onChange(of: window) { _, chosen in memory.window = chosen }
    }
}
