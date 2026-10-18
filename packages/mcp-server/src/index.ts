#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createRelayServer } from './server.js';

const { values } = parseArgs({ options: { workspace: { type: 'string', default: process.cwd() }, 'read-only': { type: 'boolean', default: false } } });
const { server, close } = createRelayServer(resolve(values.workspace), { readOnly: values['read-only'] });
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.stdin.once('end', () => void close());
await server.connect(new StdioServerTransport());
