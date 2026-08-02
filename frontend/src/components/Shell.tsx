import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen">
      <header className="border-b border-teal/15 bg-paper/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <Link to="/" className="group">
            <span className="font-display text-2xl font-bold tracking-tight text-teal-deep transition group-hover:text-teal">
              AuditAlly
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm font-medium">
            <NavLink
              to="/"
              className={({ isActive }) =>
                isActive ? 'text-teal-deep' : 'text-ink/70 hover:text-ink'
              }
              end
            >
              Scan
            </NavLink>
            {user ? (
              <>
                <NavLink
                  to="/history"
                  className={({ isActive }) =>
                    isActive ? 'text-teal-deep' : 'text-ink/70 hover:text-ink'
                  }
                >
                  History
                </NavLink>
                <span className="hidden text-ink/50 sm:inline">{user.email}</span>
                <button
                  type="button"
                  onClick={logout}
                  className="text-ink/70 hover:text-ink"
                >
                  Log out
                </button>
              </>
            ) : (
              <>
                <NavLink to="/login" className="text-ink/70 hover:text-ink">
                  Log in
                </NavLink>
                <NavLink
                  to="/signup"
                  className="rounded-md bg-teal px-3 py-1.5 text-paper hover:bg-teal-deep"
                >
                  Sign up
                </NavLink>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
