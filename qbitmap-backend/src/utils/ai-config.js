/**
 * Shared AI service configuration
 * Eliminates duplicate getVllmUrl/getModelName across ai.js, photo-ai-queue.js, video-ai-queue.js
 */

const db = require('../services/database');

async function getVllmUrl() {
  const envFallback = process.env.AI_SERVICE_URL || 'http://212.253.82.220:8000';
  const baseUrl = (await db.getSystemSetting('ai_service_url')) || envFallback;
  return `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
}

async function getVllmApiKey() {
  return (await db.getSystemSetting('ai_service_api_key')) || process.env.AI_SERVICE_API_KEY || '';
}

async function getModelName() {
  return (await db.getSystemSetting('ai_vision_model')) || 'Qwen/Qwen3-VL-8B-Instruct-FP8';
}

async function getBackendUrl() {
  return (await db.getSystemSetting('backend_public_url')) || process.env.BACKEND_PUBLIC_URL || 'https://stream.qbitmap.com';
}

module.exports = { getVllmUrl, getVllmApiKey, getModelName, getBackendUrl };
