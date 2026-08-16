// A stub OpenAI-compatible model, for exercising the copilot without a paid key.
//
// The copilot's value is in the loop rather than the prose: the model asks for a
// tool, the platform runs it and prices the result, and a proposal comes back
// that the user can accept. That loop is what breaks, and verifying it should
// not need a billing account or a network. This server plays a fixed script:
// call one tool, then answer.
//
//   node scripts/dev/stub-model.mjs 4599 propose_patch
//
// It is a development tool. Nothing ships against it, and the copilot's own
// tests use the scripted model in `apps/api/src/lib/copilot/scripted-model.ts`.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4599);
const tool = process.argv[3] ?? 'explain_node';

function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const server = createServer((request, response) => {
  if (!request.url.endsWith('/chat/completions')) {
    response.writeHead(404).end();
    return;
  }

  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const messages = parsed.messages ?? [];
    const alreadyCalled = messages.some((message) => message.role === 'tool');

    console.log(
      `[stub] ${messages.length} messages, ${parsed.tools?.length ?? 0} tools, ` +
        `${alreadyCalled ? 'answering' : `calling ${tool}`}`
    );

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });

    if (!alreadyCalled) {
      // The arguments are the tool's, so the run loop parses and runs it for
      // real: a stub that returned a proposal directly would prove nothing.
      const args = JSON.stringify(argumentsFor(tool, messages));
      response.write(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: tool, arguments: args } },
                ],
              },
            },
          ],
        })
      );
    } else {
      for (const text of ['I moved that database to two zones. ', 'It costs more and survives one.']) {
        response.write(frame({ choices: [{ delta: { content: text } }] }));
      }
    }

    response.write(frame({ usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    response.write('data: [DONE]\n\n');
    response.end();
  });
});

/** Pull a real node id out of the prompt, so the call lands on this architecture. */
function argumentsFor(name, messages) {
  const prompt = messages.map((message) => message.content ?? '').join('\n');
  const rds = /([\w-]*(?:rds|db|database|postgres|mysql)[\w-]*)\s*\(?\s*rds_instance/i.exec(prompt);
  const any = /^\s*[-*]?\s*([\w-]{3,})\s*\(/m.exec(prompt);
  const nodeId = process.env.STUB_NODE_ID ?? rds?.[1] ?? any?.[1] ?? 'unknown';

  if (name === 'propose_patch') {
    return {
      summary: 'Run the database in two availability zones',
      rationale:
        'A single-zone database is a single point of failure, and the availability model prices ' +
        'the second zone against the outage it removes.',
      ops: [{ op: 'set_param', nodeId, param: 'multiAz', value: true }],
    };
  }
  return { node_id: nodeId };
}

server.listen(port, () => console.log(`[stub] OpenAI-compatible model on :${port}`));
