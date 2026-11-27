import Foundation

/// The default "Name this iPhone": the marketing model name from the hardware identifier (iOS 16+ hides the
/// user-assigned name without a special entitlement). The person can edit it before pairing; the Mac can rename.
public enum CompanionDeviceName {
    /// Hardware identifiers (`utsname.machine`) of iPhones that run iOS 17 or later.
    static let models: [String: String] = [
        "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
        "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
        "iPhone12,8": "iPhone SE",
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,6": "iPhone SE",
        "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus", "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
        "iPhone17,5": "iPhone 16e",
        "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air", "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max",
    ]

    /// The marketing name for `identifier`, or `fallback` (the generic model, e.g. "iPhone") when it's unknown.
    public static func defaultName(identifier: String?, fallback: String) -> String {
        guard let identifier, let name = models[identifier] else { return sanitized(fallback) ?? "iPhone" }
        return name
    }

    /// The running device's hardware identifier (the Simulator reports the model it simulates).
    public static func currentIdentifier() -> String? {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? nil : machine
    }

    /// What `pair.ready` sends: trimmed, control and bidi-override characters dropped, at most 48 characters. Nil when
    /// nothing is left.
    public static func sanitized(_ name: String) -> String? {
        let cleaned = String(String.UnicodeScalarView(name.unicodeScalars.filter { scalar in
            !CharacterSet.controlCharacters.contains(scalar) && !(0x202A...0x202E).contains(scalar.value)
                && !(0x2066...0x2069).contains(scalar.value)
        })).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(CompanionWire.maxDeviceNameLength))
    }
}
