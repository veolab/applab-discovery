#!/usr/bin/env swift
/**
 * DiscoveryLab Vision Helper
 * macOS CLI tool for OCR and text analysis using Apple Vision framework
 *
 * Usage:
 *   ./VisionHelper ocr <image_path> [--fast] [--languages en,pt]
 *   ./VisionHelper analyze <image_path>
 *
 * Build:
 *   swiftc -O -o VisionHelper VisionHelper.swift
 */

import Cocoa
import Vision
import Foundation

// MARK: - Models

struct TextBlock: Codable {
    let text: String
    let confidence: Float
    let boundingBox: BoundingBox
}

struct BoundingBox: Codable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

struct OCRResult: Codable {
    let success: Bool
    let text: String
    let blocks: [TextBlock]
    let confidence: Float
    let engine: String
}

struct AnalysisResult: Codable {
    let success: Bool
    let ocr: OCRResult?
    let labels: [String]
    let dominantColors: [String]
    let imageSize: ImageSize
}

struct ImageSize: Codable {
    let width: Int
    let height: Int
}

// MARK: - Vision OCR

func performOCR(imagePath: String, fast: Bool = false, languages: [String] = ["en-US"]) -> OCRResult {
    guard let image = NSImage(contentsOfFile: imagePath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return OCRResult(
            success: false,
            text: "",
            blocks: [],
            confidence: 0,
            engine: "vision"
        )
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

    do {
        try handler.perform([request])
    } catch {
        fputs("Vision error: \(error.localizedDescription)\n", stderr)
        return OCRResult(
            success: false,
            text: "",
            blocks: [],
            confidence: 0,
            engine: "vision"
        )
    }

    guard let results = request.results else {
        return OCRResult(
            success: true,
            text: "",
            blocks: [],
            confidence: 0,
            engine: "vision"
        )
    }

    var allText = ""
    var blocks: [TextBlock] = []
    var totalConfidence: Float = 0

    for observation in results {
        guard let candidate = observation.topCandidates(1).first else { continue }

        allText += candidate.string + "\n"
        totalConfidence += candidate.confidence

        let box = observation.boundingBox
        blocks.append(TextBlock(
            text: candidate.string,
            confidence: candidate.confidence,
            boundingBox: BoundingBox(
                x: box.origin.x,
                y: box.origin.y,
                width: box.width,
                height: box.height
            )
        ))
    }

    let avgConfidence = results.isEmpty ? 0 : totalConfidence / Float(results.count)

    return OCRResult(
        success: true,
        text: allText.trimmingCharacters(in: .whitespacesAndNewlines),
        blocks: blocks,
        confidence: avgConfidence,
        engine: "vision"
    )
}

// MARK: - Image Analysis

func analyzeImage(imagePath: String) -> AnalysisResult {
    guard let image = NSImage(contentsOfFile: imagePath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return AnalysisResult(
            success: false,
            ocr: nil,
            labels: [],
            dominantColors: [],
            imageSize: ImageSize(width: 0, height: 0)
        )
    }

    // Get image size
    let imageSize = ImageSize(
        width: cgImage.width,
        height: cgImage.height
    )

    // Perform OCR
    let ocrResult = performOCR(imagePath: imagePath, fast: false)

    // Extract dominant colors (simplified)
    let dominantColors = extractDominantColors(cgImage: cgImage)

    // Classify image (if available on macOS 12+)
    var labels: [String] = []
    if #available(macOS 12.0, *) {
        labels = classifyImage(cgImage: cgImage)
    }

    return AnalysisResult(
        success: true,
        ocr: ocrResult,
        labels: labels,
        dominantColors: dominantColors,
        imageSize: imageSize
    )
}

func extractDominantColors(cgImage: CGImage) -> [String] {
    // Simplified color extraction - sample a few pixels
    guard let dataProvider = cgImage.dataProvider,
          let data = dataProvider.data,
          let bytes = CFDataGetBytePtr(data) else {
        return []
    }

    let bytesPerPixel = cgImage.bitsPerPixel / 8
    let width = cgImage.width
    let height = cgImage.height
    let bytesPerRow = cgImage.bytesPerRow

    var colorSamples: [(r: Int, g: Int, b: Int)] = []

    // Sample 9 points (3x3 grid)
    for row in [0.25, 0.5, 0.75] {
        for col in [0.25, 0.5, 0.75] {
            let x = Int(Double(width) * col)
            let y = Int(Double(height) * row)
            let offset = y * bytesPerRow + x * bytesPerPixel

            if offset + 2 < CFDataGetLength(data) {
                let r = Int(bytes[offset])
                let g = Int(bytes[offset + 1])
                let b = Int(bytes[offset + 2])
                colorSamples.append((r, g, b))
            }
        }
    }

    // Convert to hex
    return colorSamples.map { color in
        String(format: "#%02X%02X%02X", color.r, color.g, color.b)
    }
}

@available(macOS 12.0, *)
func classifyImage(cgImage: CGImage) -> [String] {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

    do {
        try handler.perform([request])
    } catch {
        return []
    }

    guard let results = request.results else {
        return []
    }

    // Return top 5 labels with confidence > 0.1
    return results
        .filter { $0.confidence > 0.1 }
        .prefix(5)
        .map { $0.identifier }
}

// MARK: - CLI

func printUsage() {
    fputs("""
    DiscoveryLab Vision Helper

    Usage:
      VisionHelper ocr <image_path> [options]
      VisionHelper analyze <image_path>

    Options:
      --fast              Use fast recognition (less accurate)
      --languages <list>  Comma-separated language codes (e.g., en,pt,es)

    Examples:
      VisionHelper ocr screenshot.png
      VisionHelper ocr screenshot.png --fast --languages en,pt
      VisionHelper analyze app-screen.png

    """, stderr)
}

func main() {
    let args = Array(CommandLine.arguments.dropFirst())

    guard args.count >= 2 else {
        printUsage()
        exit(1)
    }

    let command = args[0]
    let imagePath = args[1]

    // Parse options
    var fast = false
    var languages = ["en-US"]

    var i = 2
    while i < args.count {
        switch args[i] {
        case "--fast":
            fast = true
        case "--languages":
            if i + 1 < args.count {
                languages = args[i + 1].split(separator: ",").map { String($0) }
                i += 1
            }
        default:
            break
        }
        i += 1
    }

    // Execute command
    let encoder = JSONEncoder()
    encoder.outputFormatting = .prettyPrinted

    switch command {
    case "ocr":
        let result = performOCR(imagePath: imagePath, fast: fast, languages: languages)
        if let jsonData = try? encoder.encode(result),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
        }
        exit(result.success ? 0 : 1)

    case "analyze":
        let result = analyzeImage(imagePath: imagePath)
        if let jsonData = try? encoder.encode(result),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
        }
        exit(result.success ? 0 : 1)

    default:
        printUsage()
        exit(1)
    }
}

main()
