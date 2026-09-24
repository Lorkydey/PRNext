'use server';

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { updateTag } from 'next/cache';

export async function saveMessage(form: FormData) {
  const message = String(form.get('message') || '').trim();
  if (!message || message.length > 100) throw new Error('A message between 1 and 100 characters is required');
  await mkdir('.rustyx-cache', { recursive: true });
  const temporary = `.rustyx-cache/message-${randomUUID()}.json`;
  await writeFile(temporary, JSON.stringify({ message }));
  await rename(temporary, '.rustyx-cache/demo-message.json');
  updateTag('demo-message');
}
