/** Placeholder action for commands that are planned but not built yet. */
export function notImplemented(command: string, ticket: string): () => void {
  return () => {
    console.error(`\`jobhunter ${command}\` is not implemented yet (${ticket}).`);
    process.exitCode = 1;
  };
}
