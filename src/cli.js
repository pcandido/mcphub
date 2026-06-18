const HELP = `gtwmcp <command> [args]

Commands:
  gtwmcp add    <name>    Add or update an MCP server
  gtwmcp remove <name>    Remove an MCP server
  gtwmcp get    <name>    Show a server's configuration
  gtwmcp list             List all servers with status
  gtwmcp test   <name>    Test connection: authenticate, list tools
  gtwmcp enable <name>    Enable a server
  gtwmcp disable <name>   Disable a server
  gtwmcp serve            Start the MCP gateway in stdio mode
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

  const subcommands = new Set(['add', 'remove', 'get', 'list', 'test', 'enable', 'disable', 'serve']);

  if (!subcommands.has(subcommand)) {
    showHelp();
    process.exit(1);
  }

  // serve and list don't take a server name arg
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

  // All other subcommands require a server name
  if (rest.length === 0) {
    showHelp();
    process.exit(1);
  }

  const { default: handler } = await import(`./commands/${subcommand}.js`);
  await handler(rest);
}
