/* Software Canvas2D subset for procedural textures (QuickJS-safe, no DOM). */

export { createPixelImage, copyPixelImage, resamplePixelImage, resampleRows, axisWeights } from './image.ts';
export type { PixelImage, ResampleFilter, AxisWeights, ShadeRowSink } from './image.ts';
export { parseColor, colorToString, RasterGradient, solidShader, gradientShader, imageShader } from './paint.ts';
export type { RGBA, Shader } from './paint.ts';
export { PathBuilder, identity, multiply, invert, maxScale, meanScale, isAxisAligned, CURVE_TOLERANCE, ARC_TOLERANCE } from './path.ts';
export type { Mat2D, Subpath } from './path.ts';
export { fillPath, strokePath } from './cover.ts';
export type { IRect, RowSink, LineCap, LineJoin, StrokeStyle } from './cover.ts';
export { Context2D, RasterCanvas, createCanvas } from './context2d.ts';
export type { FillRule, ImageSource } from './context2d.ts';
