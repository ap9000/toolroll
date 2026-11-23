// Draws Toolroll's macOS app icon (a tool roll: a canvas band with three tool pockets and a rolled end, on a slate
// squircle) at 1024×1024 and writes it as a PNG. `mac/scripts/make-app-icon.sh` turns it into Assets/AppIcon.icns.
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
ctx.addPath(bodyPath); ctx.setFillColor(rgb(0x14171C)); ctx.fillPath()
ctx.restoreGState()

// Slate gradient, lighter at the top, and a hairline highlight on the upper edge.
ctx.saveGState()
ctx.addPath(bodyPath); ctx.clip()
let bg = CGGradient(colorsSpace: space, colors: [rgb(0x2B313C), rgb(0x161920), rgb(0x0E1014)] as CFArray, locations: [0, 0.55, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
ctx.restoreGState()
ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 184, cornerHeight: 184, transform: nil))
ctx.setStrokeColor(rgb(0xFFFFFF, 0.10)); ctx.setLineWidth(3); ctx.strokePath()

// The canvas band (the unrolled part), warm white with a gentle top-to-bottom shade.
let band = CGRect(x: 236, y: 318, width: 470, height: 388)
let bandPath = CGPath(roundedRect: band, cornerWidth: 46, cornerHeight: 46, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0x000000, 0.45))
ctx.addPath(bandPath); ctx.setFillColor(rgb(0xECEEF1)); ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(bandPath); ctx.clip()
let shade = CGGradient(colorsSpace: space, colors: [rgb(0xF6F7F9), rgb(0xD9DDE3)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(shade, start: CGPoint(x: 0, y: band.maxY), end: CGPoint(x: 0, y: band.minY), options: [])
ctx.restoreGState()

// Three tool pockets; the middle one carries the app's live blue.
let pocketColors: [CGColor] = [rgb(0x232831), rgb(0x3D7BE0), rgb(0x232831)]
for (index, color) in pocketColors.enumerated() {
    let x = band.minX + 70 + CGFloat(index) * 112
    let pocket = CGRect(x: x, y: band.minY + 64, width: 58, height: band.height - 128)
    ctx.addPath(CGPath(roundedRect: pocket, cornerWidth: 29, cornerHeight: 29, transform: nil))
    ctx.setFillColor(color); ctx.fillPath()
}

// The rolled end: a cylinder over the band's right edge, with two turns showing.
let roll = CGPoint(x: band.maxX + 4, y: band.midY)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: -8, height: -10), blur: 22, color: rgb(0x000000, 0.40))
ctx.addEllipse(in: CGRect(x: roll.x - 132, y: roll.y - 132, width: 264, height: 264))
ctx.setFillColor(rgb(0xE3E6EA)); ctx.fillPath()
ctx.restoreGState()
// An open spiral (rolled fabric, not rings): the radius grows as it turns, ending where the band leaves the roll.
let spiral = CGMutablePath()
let turns: CGFloat = 2.25
let steps = 240
for step in 0...steps {
    let t = CGFloat(step) / CGFloat(steps)
    let angle = t * turns * 2 * .pi + .pi
    let radius = 18 + t * 92
    let point = CGPoint(x: roll.x + cos(angle) * radius, y: roll.y + sin(angle) * radius)
    if step == 0 { spiral.move(to: point) } else { spiral.addLine(to: point) }
}
ctx.addPath(spiral)
ctx.setStrokeColor(rgb(0x7F8896)); ctx.setLineWidth(13); ctx.setLineCap(.round); ctx.setLineJoin(.round); ctx.strokePath()

guard let image = ctx.makeImage(),
      let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { fatalError("no image") }
try data.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
