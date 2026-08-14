import { Github, LogOut, UsersRound } from "lucide-react";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { getWorkspaceContext } from "@/server/session";

export default async function AccountPage() {
  const { session, workspace, workspaces } = await getWorkspaceContext();
  return (
    <div className="product-page">
      <PageHeader
        eyebrow="Settings"
        title="Account"
        description="Your GitHub identity and Patchrail workspace memberships."
      />
      <div className="account-grid">
        <Card className="account-identity">
          <div
            aria-hidden="true"
            className={`account-identity__avatar${session.user.image ? " account-identity__avatar--image" : ""}`}
            style={
              session.user.image
                ? { backgroundImage: `url(${JSON.stringify(session.user.image)})` }
                : undefined
            }
          >
            {session.user.image ? null : session.user.name.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <span className="eyebrow">GitHub identity</span>
            <h2>{session.user.name}</h2>
            <p>{session.user.email}</p>
            <StatusBadge tone="positive">
              <Github size={13} /> Authenticated with GitHub
            </StatusBadge>
          </div>
        </Card>
        <Card>
          <span className="eyebrow">Session</span>
          <h2>Sign out from any navigation</h2>
          <p className="card-copy">
            <LogOut size={16} /> Signing out invalidates this session. It does not delete
            workspaces, disconnect the GitHub App, or remove run history.
          </p>
        </Card>
      </div>
      <section className="product-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Access</span>
            <h2>Workspace memberships</h2>
          </div>
          <span className="section-count">
            <UsersRound size={15} /> {workspaces.length}
          </span>
        </div>
        <Card className="data-card">
          <ul className="membership-list">
            {workspaces.map((item) => (
              <li key={item.id}>
                <span className="membership-list__avatar">
                  {item.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.slug}</small>
                </div>
                <StatusBadge tone={item.id === workspace.id ? "accent" : "neutral"}>
                  {item.id === workspace.id ? "Current" : item.role}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
