# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

OpenCode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

OpenCode does **not** sandbox the agent. By default, Build permits shell commands and file edits without confirmation;
Plan restricts edits to its plan directory. Configured rules can ask or deny, and sensitive reads and external paths ask
by default. Permission prompts are not a security boundary.

If you need true isolation, run OpenCode inside a Docker container or VM.

### Server Mode

OpenCode clients normally discover or start a local background HTTP service. The CLI binds to loopback by default and
supplies a generated HTTP Basic Auth password when one is not configured; its server process refuses to start without a
password. If you expose the service beyond your machine, use appropriate network access controls as well as authentication.
An application embedding the fetch handler without a password must provide its own access control.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Authorized server access**   | Access to the API with valid credentials is expected behavior           |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/anomalyco/opencode/security/advisories/new) tab.

The team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, you may send an email to security@anoma.ly
