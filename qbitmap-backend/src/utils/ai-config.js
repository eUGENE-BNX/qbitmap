/**
 * Shared AI service configuration
 * Eliminates duplicate getVllmUrl/getModelName across ai.js, photo-ai-queue.js, video-ai-queue.js
 */

const db = require('../services/database');

async function getVllmUrl() {
  const envFallback = process.env.AI_SERVICE_URL || 'http://localhost:8001';
  const baseUrl = (await db.getSystemSetting('ai_service_url')) || envFallback;
  return `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
}

async function getModelName() {
  return (await db.getSystemSetting('ai_vision_model')) || 'Qwen/Qwen3-VL-8B-Instruct-FP8';
}

async function getBackendUrl() {
  return (await db.getSystemSetting('backend_public_url')) || process.env.BACKEND_PUBLIC_URL || 'https://stream.qbitmap.com';
}

module.exports = { getVllmUrl, getModelName, getBackendUrl };
