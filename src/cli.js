const HELP = `mcphub <command> [args]

Commands:
  mcphub add    <name>    Add or update an MCP server
  mcphub remove <name>    Remove an MCP server
  mcphub get    <name>    List tools and descriptions from a server
  mcphub list             List all servers with status
  mcphub auth   [name]    Authenticate OAuth servers (--force to re-auth)
  mcphub enable <name>    Enable a server
  mcphub disable <name>   Disable a server
  mcphub serve            Start the MCP gateway in stdio mode
`;

function showHelp() {
  process.stdout.write(HELP);
}

export default async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    return;
  }

  const [subcommand, ...rest] = args;

  const subcommands = new Set(['add', 'remove', 'get', 'list', 'auth', 'enable', 'disable', 'serve']);

  if (!subcommands.has(subcommand)) {
    showHelp();
    process.exit(1);
  }

  // serve, list, and auth don't require a server name arg
  if (subcommand === 'serve') {
    const { default: handler } = await import('./commands/serve.js');
    await handler();
    return;
  }
  if (subcommand === 'list') {
    const { default: handler } = await import('./commands/list.js');
    await handler();
    return;
  }
  if (subcommand === 'auth') {
    const { default: handler } = await import('./commands/auth.js');
    await handler(rest);
    return;
  }

  // All other subcommands require a server name
  if (rest.length === 0) {
    showHelp();
    process.exit(1);
  }

  const { default: handler } = await import(`./commands/${subcommand}.js`);
  await handler(rest);
}
