/** The `luau` CLI that runs the production Tern plugin in tests. Missing it fails the suite. */
export function luauBinary(): string {
  const binary = process.env.TANDEM_LUAU_BINARY ?? Bun.which("luau");
  if (binary === null || binary === undefined)
    throw new Error(
      "The Tern plugin tests need the luau CLI. Install it with `brew install luau`, or set TANDEM_LUAU_BINARY.",
    );
  return binary;
}
