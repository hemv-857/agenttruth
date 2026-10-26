import path from 'node:path';

// Findings, ignore patterns, and GitHub annotations all speak forward slashes;
// path.relative speaks the platform's separator. Normalize at the boundary so
// one repo behaves the same on Windows as on CI.
export const toPosix = (p) => p.split(path.sep).join('/');
