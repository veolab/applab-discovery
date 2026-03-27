# ESVP Protocol Integration

DiscoveryLab includes a built-in client for the open [ESVP protocol](https://esvp.dev) by Entropy Lab — enabling reproducible mobile sessions, automated replay, and network-aware validation.

## Configuration

| Mode | How |
|------|-----|
| **Remote** | Set `ESVP_BASE_URL=http://your-esvp-host:8787` |
| **Local** | Leave `ESVP_BASE_URL` unset — DiscoveryLab boots an embedded local runtime |
| **Dev (custom module)** | Set `DISCOVERYLAB_ESVP_LOCAL_MODULE=/path/to/esvp-server-reference/server.js` |

## MCP Tools

| Tool | Description |
|------|-------------|
| `dlab.esvp.status` | Check control-plane health |
| `dlab.esvp.devices` | List available devices |
| `dlab.esvp.sessions.list` | List sessions |
| `dlab.esvp.session.create` | Create session (ios-sim, maestro-ios, adb) |
| `dlab.esvp.session.get` | Get session details |
| `dlab.esvp.session.inspect` | Inspect session state |
| `dlab.esvp.session.transcript` | Get session transcript |
| `dlab.esvp.session.artifacts.list` | List artifacts |
| `dlab.esvp.session.artifact.get` | Get specific artifact |
| `dlab.esvp.session.actions` | Run actions on session |
| `dlab.esvp.session.checkpoint` | Create checkpoint |
| `dlab.esvp.session.finish` | Finish session |
| `dlab.esvp.replay.run` | Replay recording |
| `dlab.esvp.replay.validate` | Validate replay |
| `dlab.esvp.session.network` | Get network data |
| `dlab.esvp.network.configure` | Configure network proxy |
| `dlab.esvp.network.trace.attach` | Attach network trace |
| `dlab.project.esvp.current` | Get current project ESVP state |
| `dlab.project.esvp.validate` | Validate project recording |
| `dlab.project.esvp.replay` | Replay project recording |
| `dlab.project.esvp.sync_network` | Sync network traces |
| `dlab.project.esvp.app_trace_bootstrap` | Bootstrap app tracing |

## CLI Commands

```bash
discoverylab esvp status
discoverylab esvp devices
discoverylab esvp sessions
discoverylab esvp create
discoverylab esvp get <sessionId>
discoverylab esvp inspect <sessionId>
discoverylab esvp transcript <sessionId>
discoverylab esvp artifacts <sessionId>
discoverylab esvp artifact <sessionId> <artifactPath>
discoverylab esvp actions <sessionId>
discoverylab esvp checkpoint <sessionId>
discoverylab esvp finish <sessionId>
discoverylab esvp replay-run <sessionId>
discoverylab esvp replay-validate <sessionId>
discoverylab esvp replay-consistency <sessionId>
discoverylab esvp network <sessionId>
discoverylab esvp network-configure <sessionId>
discoverylab esvp network-clear <sessionId>
discoverylab esvp trace-attach <sessionId>
```

## Network Proxy

DiscoveryLab defaults to `external-proxy` mode — the proxy runs locally and ESVP only persists traces.

### Host Rules

| Setup | Proxy Address |
|-------|--------------|
| macOS + iOS Simulator | `127.0.0.1` |
| macOS/Linux + Android Emulator | `10.0.2.2` |
| Physical Android | Host LAN IP |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `DISCOVERYLAB_NETWORK_PROXY_PORT` | Proxy port |
| `DISCOVERYLAB_NETWORK_PROXY_HOST` | Proxy host for device |
| `DISCOVERYLAB_NETWORK_PROXY_BIND_HOST` | Bind address (LAN) |
| `DISCOVERYLAB_NETWORK_PROXY_PROTOCOL` | Protocol (http/https) |
| `DISCOVERYLAB_NETWORK_PROXY_BYPASS` | Bypass patterns |
| `DISCOVERYLAB_NETWORK_PROXY_MAX_DURATION_MS` | Auto-finalize timeout (default: 15min) |

### Safety

- Proxies auto-finalize after 15 minutes to prevent stale proxy state
- Settings UI has an emergency lock and "Disable Active Proxy Now" button
- Server shutdown auto-cleans active proxies

## Example Prompts

```
Check my ESVP control-plane health
Create an ios-sim ESVP session and take a screenshot
Replay this iOS recording with an external proxy
Configure a proxy on this session and attach the HTTP trace
```

## Programmatic Usage

```ts
import { createESVPSession, runESVPActions } from '@veolab/discoverylab';

const created = await createESVPSession({
  executor: 'ios-sim',
  meta: { source: 'demo' },
});

await runESVPActions(created.session.id, {
  actions: [{ name: 'screenshot' }],
  finish: true,
});
```
