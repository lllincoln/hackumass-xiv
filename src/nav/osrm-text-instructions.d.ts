declare module 'osrm-text-instructions' {
  interface Compiler {
    compile(language: string, step: unknown, options?: Record<string, unknown>): string;
  }
  export default function osrmTextInstructions(version: string): Compiler;
}
