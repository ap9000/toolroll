// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ToolrollMac",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "ToolrollCore", targets: ["ToolrollCore"]),
        .executable(name: "ToolrollApp", targets: ["ToolrollApp"]),
    ],
    targets: [
        .target(
            name: "ToolrollCore",
            path: "Sources/ToolrollCore"
        ),
        .executableTarget(
            name: "ToolrollApp",
            dependencies: ["ToolrollCore"],
            path: "Sources/ToolrollApp"
        ),
        .testTarget(
            name: "ToolrollCoreTests",
            dependencies: ["ToolrollCore"],
            path: "Tests/ToolrollCoreTests"
        ),
    ]
)
