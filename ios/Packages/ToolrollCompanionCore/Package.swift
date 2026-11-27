// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ToolrollCompanionCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "ToolrollCompanionCore",
            targets: ["ToolrollCompanionCore"]
        ),
    ],
    targets: [
        .target(
            name: "ToolrollCompanionCore",
            path: "Sources/ToolrollCompanionCore"
        ),
        .testTarget(
            name: "ToolrollCompanionCoreTests",
            dependencies: ["ToolrollCompanionCore"],
            path: "Tests/ToolrollCompanionCoreTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
