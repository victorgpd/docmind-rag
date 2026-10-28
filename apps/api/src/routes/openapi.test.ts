import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { openapiRouter } from './openapi';

it('serves the OpenAPI document at /api/v1/openapi.json', async () => {
  const app = express().use('/api/v1', openapiRouter());
  const r = await request(app).get('/api/v1/openapi.json');
  expect(r.status).toBe(200);
  expect(Object.keys(r.body.paths)).toContain('/api/v1/collections');
});
