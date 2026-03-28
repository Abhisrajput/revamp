# REVAMP - VS Code Extension

AI-powered legacy code modernization directly in your VS Code editor.

## Features

- **Code Analysis**: Analyze files for legacy patterns and modernization opportunities
- **AI-Powered Modernization**: Transform legacy code to modern standards using LLM
- **Project Management**: Create and manage modernization projects
- **Pipeline Execution**: Run full modernization pipelines with approval gates
- **Real-time Streaming**: Stream analysis and modernization results in real-time
- **Dashboard**: Visual project and pipeline monitoring
- **Workspace Analysis**: Automatically scan workspace for legacy patterns

## Installation

1. Build the extension:
   ```bash
   npm install
   npm run build
   ```

2. Install in VS Code:
   - Press `Ctrl+K Ctrl+X` (or `Cmd+K Cmd+X` on Mac) to open Extensions
   - Select "Install from VSIX..." and choose the packaged extension

3. Configure settings:
   - Open VS Code Settings
   - Search for "REVAMP"
   - Set `revamp.apiUrl` to your API server (default: `http://localhost:3000`)

## Usage

### Sign In

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run "REVAMP: Sign In"
3. Enter your email and password

### Analyze Code

1. Open a code file
2. Right-click and select "REVAMP: Analyze Code"
3. View results in the output panel

### Modernize File

1. Open a code file
2. Right-click and select "REVAMP: Modernize This File"
3. Choose action: Apply Changes, Create New File, or Diff View

### Run Pipeline

1. Open Command Palette
2. Run "REVAMP: Run Modernization Pipeline"
3. Select a project
4. Monitor progress in the notification panel

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `revamp.apiUrl` | string | `http://localhost:3000` | REVAMP API server URL |
| `revamp.defaultModel` | string | `gpt-4-turbo` | Default LLM model |
| `revamp.autoAnalyze` | boolean | `false` | Auto-analyze files on open |
| `revamp.enableNotifications` | boolean | `true` | Show toast notifications |

## Commands

- `revamp.signin` - Sign in to REVAMP
- `revamp.startProject` - Create a new project
- `revamp.analyzeCode` - Analyze current file
- `revamp.modernizeFile` - Modernize current file
- `revamp.runPipeline` - Run modernization pipeline
- `revamp.showDashboard` - Show REVAMP dashboard
- `revamp.compareVersions` - Compare original and modernized code
- `revamp.logout` - Sign out

## Architecture

- **Extension Host**: VS Code extension API
- **API Client**: Axios-based HTTP client for REVAMP API
- **LLM Stream**: Server-Sent Events for real-time streaming
- **Tree Providers**: Project and pipeline visualization
- **Webview**: Dashboard and UI panels

## Development

### Build for development:
```bash
npm run dev
```

### Watch mode:
```bash
npm run watch
```

### Type checking:
```bash
npm run type-check
```

## API Requirements

The extension requires a running REVAMP API server with:
- Authentication endpoints (`/auth/signin`, `/auth/verify`)
- Project endpoints (`/projects`, etc.)
- Pipeline endpoints (`/pipeline/start`, etc.)
- Agent endpoints (`/agents/execute`)

## Troubleshooting

### Connection Error
- Verify REVAMP API server is running
- Check `revamp.apiUrl` setting
- Check network connectivity

### Analysis Timeouts
- Increase API server timeout settings
- Check LLM model availability
- Verify sufficient system resources

### Authentication Issues
- Clear stored credentials: `revamp.logout`
- Re-authenticate with correct credentials
- Check user account status

## License

MIT
