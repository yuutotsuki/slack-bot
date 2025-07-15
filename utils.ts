export function redactSensitive(str: string): string {
  return str
    .replace(/Bearer [\w\-\.]+/g, 'Bearer ***')
    .replace(/token["']?: ?["']?[\w\-\.]+["']?/gi, 'token: "***"');
} 