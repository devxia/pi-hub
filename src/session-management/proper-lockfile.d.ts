declare module 'proper-lockfile' {
  /** Public proper-lockfile API, shared with Pi's settings writer. */
  export function lock(
    path: string,
    options: { realpath: boolean; onCompromised: (error: Error) => void },
  ): Promise<() => Promise<void>>;
}
