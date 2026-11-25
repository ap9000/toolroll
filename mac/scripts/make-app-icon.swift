// Draws Toolroll's macOS app icon (the three-bar brand mark on the dark theme's neutral ground, in Apple's squircle) at 1024×1024 and writes it as a PNG. `mac/scripts/make-app-icon.sh` turns it into Assets/AppIcon.icns.
//   swift mac/scripts/make-app-icon.swift <out.png>
import AppKit
import CoreGraphics

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

let space = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("no context") }

// Body: Apple's icon grid (824 pt body inside 1024, ~22.5% corner radius), with a soft drop shadow.
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let bodyPath = CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 34, color: rgb(0x000000, 0.35))
ctx.addPath(bodyPath); ctx.setFillColor(rgb(0x161616)); ctx.fillPath()
ctx.restoreGState()

// Slate gradient, lighter at the top, and a hairline highlight on the upper edge.
ctx.saveGState()
ctx.addPath(bodyPath); ctx.clip()
let bg = CGGradient(colorsSpace: space, colors: [rgb(0x262626), rgb(0x161616), rgb(0x0B0B0B)] as CFArray, locations: [0, 0.55, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
ctx.restoreGState()
ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 184, cornerHeight: 184, transform: nil))
ctx.setStrokeColor(rgb(0xFFFFFF, 0.10)); ctx.setLineWidth(3); ctx.strokePath()

// Toolroll's mark, as the web draws it (workspace.css .so-brand-mark): three bars, the middle one taller, slanted
// 10°, in the dark theme's ink (#ededed) on its ground — the same symbol in the Dock, the sidebar and the browser.
let unit: CGFloat = 26                         // 1 CSS px of the 16×20 mark, scaled into the icon body
let barWidth = 3.5 * unit, gap = 3 * unit
let heights: [CGFloat] = [13 * unit, 20 * unit, 13 * unit]
let markWidth = barWidth * 3 + gap * 2
let originX = 512 - markWidth / 2
ctx.saveGState()
// Slant around the icon's centre: y' = y + tan(10°)·(x − 512), so the bars rise to the right like the web's skewY(-10deg).
ctx.translateBy(x: 512, y: 512)
ctx.concatenate(CGAffineTransform(a: 1, b: tan(10 * .pi / 180), c: 0, d: 1, tx: 0, ty: 0))
ctx.translateBy(x: -512, y: -512)
ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 18, color: rgb(0x000000, 0.45))
for (index, height) in heights.enumerated() {
    let x = originX + CGFloat(index) * (barWidth + gap)
    let bar = CGRect(x: x, y: 512 - height / 2, width: barWidth, height: height)
    ctx.addPath(CGPath(roundedRect: bar, cornerWidth: unit, cornerHeight: unit, transform: nil))
    ctx.setFillColor(rgb(0xEDEDED)); ctx.fillPath()
}
ctx.restoreGState()

guard let image = ctx.makeImage(),
      let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { fatalError("no image") }
try data.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
