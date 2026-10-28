import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { errorHandler } from './errors';
import { upload } from './upload';

const app = express();
app.post('/up', upload(10).single('file'), (_req, res) => void res.status(201).end());
app.use(errorHandler);

it('MulterError vira 413 file_too_large e 400 para campo inesperado', async () => {
  const big = await request(app).post('/up').attach('file', Buffer.alloc(100), 'a.txt');
  expect(big.status).toBe(413);
  expect(big.body.error.code).toBe('file_too_large');
  const other = await request(app).post('/up').attach('outro', Buffer.from('x'), 'a.txt');
  expect(other.status).toBe(400);
  expect(other.body.error.code).toBe('limit_unexpected_file');
  expect((await request(app).post('/up').attach('file', Buffer.from('x'), 'a.txt')).status).toBe(201);
});
