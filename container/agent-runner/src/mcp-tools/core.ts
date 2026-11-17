/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo, getCurrentReplyRoute } from '../db/session-state.js';
import { resolveDestinationThread } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * A channel destination is threaded like the poll loop's explicit deliveries:
 * the thread of the message being answered (the published reply stamp) when it
 * came from that channel, else that channel's latest inbound thread. An agent
 * destination never carries a thread.
 */
function resolveRouting(
  to: string,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id:
        resolveDestinationThread(dest.channelType!, dest.platformId!, getCurrentReplyRoute())?.threadId ?? null,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination.',
    // How the agent talks to people mid-task: never deferred behind tool
    // search, so it never has to guess the name (it once called a made-up
    // `send_message_placeholder` instead of loading this).
    _meta: { 'anthropic/alwaysLoad': true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1").',
        },
        text: { type: 'string', description: 'Message content' },
        new_thread: {
          type: 'boolean',
          description:
            'Post as a new top-level message in a group channel, starting a new thread, instead of replying in the current one. Only when someone asks for a new thread.',
        },
        handoff: {
          type: 'string',
          description:
            'With new_thread: a note to yourself for the new thread (what it is about, where it came from, any pull request it owns). You read it when someone replies there.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'With new_thread: files to post, e.g. the image the thread is about (paths absolute or relative to /workspace/agent/). They go with thread_reply inside the thread when there is one, otherwise with the post.',
        },
        thread_reply: {
          type: 'string',
          description:
            'With new_thread: posted as the first reply inside the new thread, right after `text`. For continuing something in a new thread: `text` a short line, the content here. Leave it out for a plain new channel message.',
        },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    const newThread = args.new_thread === true;
    const handoff = typeof args.handoff === 'string' ? args.handoff.trim() : '';
    const threadReply = typeof args.thread_reply === 'string' ? args.thread_reply.trim() : '';
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!text) return err('text is required');
    const filePaths = Array.isArray(args.files) ? (args.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    if ((handoff || threadReply || filePaths.length > 0) && !newThread) {
      return err('handoff, thread_reply and files only apply with new_thread: true');
    }
    const resolvedFiles = filePaths.map((f) => (path.isAbsolute(f) ? f : path.resolve('/workspace/agent', f)));
    const missing = filePaths.filter((_, i) => !fs.existsSync(resolvedFiles[i]));
    if (missing.length > 0) return err(`File not found: ${missing.join(', ')}`);

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);
    if (newThread && routing.channel_type === 'agent') {
      return err(`new_thread needs a channel destination; "${to}" is an agent`);
    }

    const id = generateId();
    // Stage files like send_file does; the host attaches them to the opener.
    const filenames: string[] = [];
    if (resolvedFiles.length > 0) {
      const outboxDir = path.join('/workspace/outbox', id);
      fs.mkdirSync(outboxDir, { recursive: true });
      for (const file of resolvedFiles) {
        let name = path.basename(file);
        for (let n = 2; filenames.includes(name); n++) {
          const ext = path.extname(file);
          name = `${path.basename(file, ext)}-${n}${ext}`;
        }
        fs.copyFileSync(file, path.join(outboxDir, name));
        filenames.push(name);
      }
    }
    const seq = await writeMessageOut({
      id,
      // A new thread answers nothing: no reply quote, no thread.
      in_reply_to: newThread ? null : getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: newThread ? null : routing.thread_id,
      content: JSON.stringify(
        newThread
          ? {
              text,
              newThread: true,
              ...(filenames.length > 0 ? { files: filenames } : {}),
              ...(threadReply ? { threadReply } : {}),
              ...(handoff ? { handoff } : {}),
            }
          : { text },
      ),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}${newThread ? ' (new thread)' : ''}`);
    return ok(
      newThread
        ? `Posted to ${routing.resolvedName} as a new thread (id: ${seq}). Replies there reach you in a separate conversation that starts with your handoff note; it doesn't see this one.`
        : `Message sent to ${routing.resolvedName} (id: ${seq})`,
    );
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['to', 'path'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const filePath = args.path as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!filePath) return err('path is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction]);
