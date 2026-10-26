// Edge scrolling changes only the visible viewport, never queue data.
export function queueDragScrollDirection(clientY, height, edge = 110) {
  if (!Number.isFinite(clientY) || !Number.isFinite(height) || height <= 0) return 0;
  edge = Math.min(edge, height / 3);
  return clientY < edge ? -1 : clientY > height - edge ? 1 : 0;
}
