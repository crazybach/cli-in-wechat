export interface ResponseMeta {
  tool?: string;
  duration?: number;
  cost?: number;
  error?: boolean;
}

/**
 * Format a CLI tool response for sending to WeChat.
 * Appends a footer with tool name, duration, and cost.
 */
export function formatResponse(text: string, meta?: ResponseMeta): string {
  const parts: string[] = [];

  if (meta?.error) {
    parts.push('[错误]');
  }

  parts.push(text);

  // Metadata footer
  const footer: string[] = [];
  if (meta?.tool) footer.push(meta.tool);
  if (meta?.duration) {
    const sec = meta.duration / 1000;
    footer.push(sec >= 60 ? `${(sec / 60).toFixed(1)}min` : `${sec.toFixed(1)}s`);
  }
  if (meta?.cost !== undefined && meta.cost > 0) {
    footer.push(`$${meta.cost.toFixed(4)}`);
  }

  if (footer.length > 0) {
    parts.push(`\n— ${footer.join(' | ')}`);
  }

  return parts.join('\n');
}
