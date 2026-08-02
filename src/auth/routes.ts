import { Router, type Request, type Response, type NextFunction } from 'express';
import { registerUser, loginUser, verifyToken } from './auth';

export const authRouter = Router();

authRouter.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, name } = req.body ?? {};
    const result = await registerUser(email, password, name);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body ?? {};
    const result = await loginUser(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    res.json({ id: payload.userId, email: payload.email });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});
