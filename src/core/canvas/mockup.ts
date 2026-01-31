/**
 * DiscoveryLab 3D Mockup Module
 * Device mockups using Three.js (server-side rendering)
 */

// ============================================================================
// TYPES
// ============================================================================
export interface DeviceModel {
  id: string;
  name: string;
  type: 'phone' | 'tablet' | 'browser';
  dimensions: {
    width: number;
    height: number;
    depth: number;
    screenWidth: number;
    screenHeight: number;
    bezelTop: number;
    bezelBottom: number;
    bezelSide: number;
    cornerRadius: number;
  };
  colors: {
    frame: string;
    screen: string;
    bezel: string;
  };
}

export interface MockupOptions {
  device: string; // Device ID
  screenshot: string; // Path to screenshot image
  rotation?: { x: number; y: number; z: number };
  scale?: number;
  perspective?: number;
  shadow?: boolean;
  backgroundColor?: string;
  outputWidth?: number;
  outputHeight?: number;
}

export interface MockupResult {
  success: boolean;
  error?: string;
  canvas?: any; // Canvas data for further processing
  dimensions?: { width: number; height: number };
}

// ============================================================================
// DEVICE CATALOG
// ============================================================================
export const devices: Record<string, DeviceModel> = {
  // iPhone Models
  'iphone-15-pro': {
    id: 'iphone-15-pro',
    name: 'iPhone 15 Pro',
    type: 'phone',
    dimensions: {
      width: 71.6,
      height: 146.6,
      depth: 8.25,
      screenWidth: 67,
      screenHeight: 140,
      bezelTop: 3,
      bezelBottom: 3,
      bezelSide: 2.3,
      cornerRadius: 12,
    },
    colors: {
      frame: '#1f1f1f',
      screen: '#000000',
      bezel: '#1a1a1a',
    },
  },
  'iphone-15': {
    id: 'iphone-15',
    name: 'iPhone 15',
    type: 'phone',
    dimensions: {
      width: 71.6,
      height: 147.6,
      depth: 7.8,
      screenWidth: 67,
      screenHeight: 141,
      bezelTop: 3,
      bezelBottom: 3,
      bezelSide: 2.3,
      cornerRadius: 12,
    },
    colors: {
      frame: '#f5f5f7',
      screen: '#000000',
      bezel: '#e8e8ed',
    },
  },
  'iphone-se': {
    id: 'iphone-se',
    name: 'iPhone SE',
    type: 'phone',
    dimensions: {
      width: 67.3,
      height: 138.4,
      depth: 7.3,
      screenWidth: 61,
      screenHeight: 110,
      bezelTop: 14,
      bezelBottom: 14,
      bezelSide: 3,
      cornerRadius: 8,
    },
    colors: {
      frame: '#1f1f1f',
      screen: '#000000',
      bezel: '#1a1a1a',
    },
  },

  // Android Models
  'pixel-8': {
    id: 'pixel-8',
    name: 'Google Pixel 8',
    type: 'phone',
    dimensions: {
      width: 70.8,
      height: 150.5,
      depth: 8.9,
      screenWidth: 66,
      screenHeight: 144,
      bezelTop: 3,
      bezelBottom: 3,
      bezelSide: 2.4,
      cornerRadius: 10,
    },
    colors: {
      frame: '#1f1f1f',
      screen: '#000000',
      bezel: '#2a2a2a',
    },
  },
  'samsung-s24': {
    id: 'samsung-s24',
    name: 'Samsung Galaxy S24',
    type: 'phone',
    dimensions: {
      width: 70.6,
      height: 147.0,
      depth: 7.6,
      screenWidth: 66,
      screenHeight: 141,
      bezelTop: 3,
      bezelBottom: 3,
      bezelSide: 2.3,
      cornerRadius: 10,
    },
    colors: {
      frame: '#1f1f1f',
      screen: '#000000',
      bezel: '#1a1a1a',
    },
  },

  // iPad Models
  'ipad-pro-12': {
    id: 'ipad-pro-12',
    name: 'iPad Pro 12.9"',
    type: 'tablet',
    dimensions: {
      width: 214.9,
      height: 280.6,
      depth: 5.9,
      screenWidth: 206,
      screenHeight: 272,
      bezelTop: 4,
      bezelBottom: 4,
      bezelSide: 4.5,
      cornerRadius: 18,
    },
    colors: {
      frame: '#1f1f1f',
      screen: '#000000',
      bezel: '#1a1a1a',
    },
  },
  'ipad-air': {
    id: 'ipad-air',
    name: 'iPad Air',
    type: 'tablet',
    dimensions: {
      width: 178.5,
      height: 247.6,
      depth: 6.1,
      screenWidth: 170,
      screenHeight: 239,
      bezelTop: 4,
      bezelBottom: 4,
      bezelSide: 4.3,
      cornerRadius: 16,
    },
    colors: {
      frame: '#f5f5f7',
      screen: '#000000',
      bezel: '#e8e8ed',
    },
  },

  // Browser Mockups
  'browser-chrome': {
    id: 'browser-chrome',
    name: 'Chrome Browser',
    type: 'browser',
    dimensions: {
      width: 1280,
      height: 800,
      depth: 0,
      screenWidth: 1280,
      screenHeight: 740,
      bezelTop: 60, // Browser chrome
      bezelBottom: 0,
      bezelSide: 0,
      cornerRadius: 8,
    },
    colors: {
      frame: '#dee1e6',
      screen: '#ffffff',
      bezel: '#dee1e6',
    },
  },
  'browser-safari': {
    id: 'browser-safari',
    name: 'Safari Browser',
    type: 'browser',
    dimensions: {
      width: 1280,
      height: 800,
      depth: 0,
      screenWidth: 1280,
      screenHeight: 748,
      bezelTop: 52,
      bezelBottom: 0,
      bezelSide: 0,
      cornerRadius: 10,
    },
    colors: {
      frame: '#f5f5f7',
      screen: '#ffffff',
      bezel: '#f5f5f7',
    },
  },
};

// ============================================================================
// DEVICE HELPERS
// ============================================================================
export function getDevice(id: string): DeviceModel | null {
  return devices[id] || null;
}

export function listDevices(): DeviceModel[] {
  return Object.values(devices);
}

export function listDevicesByType(type: 'phone' | 'tablet' | 'browser'): DeviceModel[] {
  return Object.values(devices).filter((d) => d.type === type);
}

export function getDeviceAspectRatio(device: DeviceModel): number {
  return device.dimensions.screenWidth / device.dimensions.screenHeight;
}

// ============================================================================
// MOCKUP CONFIGURATION
// ============================================================================
export interface MockupConfig {
  device: DeviceModel;
  screenshot: string;
  rotation: { x: number; y: number; z: number };
  scale: number;
  perspective: number;
  shadow: boolean;
  backgroundColor: string;
  outputWidth: number;
  outputHeight: number;
}

export function createMockupConfig(options: MockupOptions): MockupConfig | null {
  const device = getDevice(options.device);
  if (!device) {
    return null;
  }

  return {
    device,
    screenshot: options.screenshot,
    rotation: options.rotation || { x: 0, y: 0, z: 0 },
    scale: options.scale || 1,
    perspective: options.perspective || 1000,
    shadow: options.shadow ?? true,
    backgroundColor: options.backgroundColor || '#ffffff',
    outputWidth: options.outputWidth || 1920,
    outputHeight: options.outputHeight || 1080,
  };
}

// ============================================================================
// CSS 3D TRANSFORM GENERATION
// ============================================================================
export interface CSS3DTransform {
  transform: string;
  transformOrigin: string;
  perspective: string;
}

export function generateCSS3DTransform(config: MockupConfig): CSS3DTransform {
  const { rotation, scale, perspective } = config;

  const transforms = [
    `perspective(${perspective}px)`,
    `rotateX(${rotation.x}deg)`,
    `rotateY(${rotation.y}deg)`,
    `rotateZ(${rotation.z}deg)`,
    `scale(${scale})`,
  ];

  return {
    transform: transforms.join(' '),
    transformOrigin: 'center center',
    perspective: `${perspective}px`,
  };
}

// ============================================================================
// SVG MOCKUP GENERATION (Fallback for server-side)
// ============================================================================
export function generateSVGMockup(config: MockupConfig): string {
  const { device, backgroundColor, outputWidth, outputHeight, shadow } = config;
  const { dimensions, colors } = device;

  // Calculate scale to fit device in output
  const deviceAspect = dimensions.width / dimensions.height;
  const outputAspect = outputWidth / outputHeight;

  let deviceWidth: number;
  let deviceHeight: number;

  if (deviceAspect > outputAspect) {
    deviceWidth = outputWidth * 0.6;
    deviceHeight = deviceWidth / deviceAspect;
  } else {
    deviceHeight = outputHeight * 0.8;
    deviceWidth = deviceHeight * deviceAspect;
  }

  const deviceX = (outputWidth - deviceWidth) / 2;
  const deviceY = (outputHeight - deviceHeight) / 2;

  // Screen dimensions within device
  const screenScaleX = dimensions.screenWidth / dimensions.width;
  const screenScaleY = dimensions.screenHeight / dimensions.height;
  const screenWidth = deviceWidth * screenScaleX;
  const screenHeight = deviceHeight * screenScaleY;
  const screenX = deviceX + (deviceWidth - screenWidth) / 2;
  const screenY = deviceY + (deviceHeight * dimensions.bezelTop) / dimensions.height;

  const cornerRadius = (dimensions.cornerRadius / dimensions.width) * deviceWidth;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">
  <defs>
    ${shadow ? `
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="10" stdDeviation="20" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
    ` : ''}
    <clipPath id="screenClip">
      <rect x="${screenX}" y="${screenY}" width="${screenWidth}" height="${screenHeight}" rx="${cornerRadius * 0.8}"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="100%" height="100%" fill="${backgroundColor}"/>

  <!-- Device Frame -->
  <rect x="${deviceX}" y="${deviceY}" width="${deviceWidth}" height="${deviceHeight}"
        rx="${cornerRadius}" fill="${colors.frame}" ${shadow ? 'filter="url(#shadow)"' : ''}/>

  <!-- Screen Background -->
  <rect x="${screenX}" y="${screenY}" width="${screenWidth}" height="${screenHeight}"
        rx="${cornerRadius * 0.8}" fill="${colors.screen}"/>

  <!-- Screenshot Placeholder (use xlink:href for actual image) -->
  <g clip-path="url(#screenClip)">
    <rect x="${screenX}" y="${screenY}" width="${screenWidth}" height="${screenHeight}"
          fill="#1a1a1a"/>
    <text x="${screenX + screenWidth / 2}" y="${screenY + screenHeight / 2}"
          text-anchor="middle" dominant-baseline="middle"
          fill="#666" font-family="system-ui" font-size="14">
      Screenshot
    </text>
  </g>
</svg>`;

  return svg;
}

// ============================================================================
// HTML MOCKUP TEMPLATE
// ============================================================================
export function generateHTMLMockup(config: MockupConfig, screenshotDataUrl?: string): string {
  const { device, backgroundColor, outputWidth, outputHeight, rotation, scale, shadow } = config;
  const { dimensions, colors } = device;

  const transform = generateCSS3DTransform(config);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${outputWidth}px;
      height: ${outputHeight}px;
      background: ${backgroundColor};
      display: flex;
      align-items: center;
      justify-content: center;
      perspective: ${config.perspective}px;
      overflow: hidden;
    }
    .device {
      position: relative;
      width: ${dimensions.width * 4}px;
      height: ${dimensions.height * 4}px;
      background: ${colors.frame};
      border-radius: ${dimensions.cornerRadius * 4}px;
      transform: ${transform.transform};
      transform-style: preserve-3d;
      ${shadow ? `box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);` : ''}
    }
    .screen {
      position: absolute;
      top: ${dimensions.bezelTop * 4}px;
      left: ${dimensions.bezelSide * 4}px;
      width: ${dimensions.screenWidth * 4}px;
      height: ${dimensions.screenHeight * 4}px;
      background: ${colors.screen};
      border-radius: ${dimensions.cornerRadius * 3}px;
      overflow: hidden;
    }
    .screen img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  </style>
</head>
<body>
  <div class="device">
    <div class="screen">
      ${screenshotDataUrl ? `<img src="${screenshotDataUrl}" alt="Screenshot"/>` : '<div style="width:100%;height:100%;background:#1a1a1a;"></div>'}
    </div>
  </div>
</body>
</html>`;
}

// ============================================================================
// PRESET ROTATIONS
// ============================================================================
export const rotationPresets = {
  flat: { x: 0, y: 0, z: 0 },
  tiltLeft: { x: 5, y: -15, z: 0 },
  tiltRight: { x: 5, y: 15, z: 0 },
  hero: { x: 10, y: -20, z: 5 },
  heroRight: { x: 10, y: 20, z: -5 },
  dramatic: { x: 15, y: -30, z: 10 },
  topDown: { x: 45, y: 0, z: 0 },
  isometric: { x: 35, y: -45, z: 0 },
};

export type RotationPreset = keyof typeof rotationPresets;

export function getRotationPreset(preset: RotationPreset): { x: number; y: number; z: number } {
  return rotationPresets[preset] || rotationPresets.flat;
}
