import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count == 4, let expectedFPS = Int(args[3]), expectedFPS > 0 else {
    throw CocoaError(.fileReadInvalidFileName)
}
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let track = try await asset.loadTracks(withMediaType: .video).first else {
    throw CocoaError(.fileReadCorruptFile)
}
let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
])
output.alwaysCopiesSampleData = false
reader.add(output)
guard reader.startReading() else { throw reader.error ?? CocoaError(.fileReadCorruptFile) }
var decoded = Data()
var frameCount = 0
while let sample = output.copyNextSampleBuffer() {
    guard let buffer = sample.imageBuffer else { throw CocoaError(.fileReadCorruptFile) }
    if frameCount % expectedFPS == expectedFPS / 2 {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        for y in 0..<height {
            decoded.append(base + y * stride, count: width)
        }
    }
    frameCount += 1
}
guard reader.status == .completed else { throw reader.error ?? CocoaError(.fileReadCorruptFile) }
try decoded.write(to: URL(fileURLWithPath: args[2]), options: .withoutOverwriting)
print("Decoded \(frameCount) frames to sample \(frameCount / expectedFPS) seconds")
