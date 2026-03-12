import type { Express, Request } from 'express';
import type { ChannelBridgeManager } from '../../bridges/manager.js';

export interface ChannelRoutesDeps {
  channelBridgeManager: ChannelBridgeManager;
}

function isLocalRequest(req: Request): boolean {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
}

export function registerChannelRoutes(app: Express, deps: ChannelRoutesDeps): void {
  app.post('/api/v1/channels/send', async (req, res) => {
    const body = req.body as { channelId?: string; to?: string; text?: string; replyTo?: string };
    const allow = process.env.FINGER_ALLOW_CHANNEL_SEND === '1' || process.env.NODE_ENV !== 'production' || isLocalRequest(req);

    if (!allow) {
      res.status(403).json({ error: 'Channel send not allowed' });
      return;
    }

    if (!body?.channelId || !body?.to || !body?.text) {
      res.status(400).json({ error: 'Missing channelId, to, or text' });
      return;
    }

    try {
      const result = await deps.channelBridgeManager.sendMessage(body.channelId, {
        to: body.to,
        text: body.text,
        replyTo: body.replyTo,
      });
      res.json({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });
}
