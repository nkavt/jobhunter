/** Placeholder action for commands that are planned but not built yet. */
export function notImplemented(command: string): () => void {
  return () => {
    console.error(`\`jobhunter ${command}\` is not implemented yet.`);
    process.exitCode = 1;
  };
}
