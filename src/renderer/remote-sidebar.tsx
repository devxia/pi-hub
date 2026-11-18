import { useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Ellipsis, Plus, Search, Server as ServerIcon, Terminal } from 'lucide-react';
import type { Server } from '../remote/contract';

function SidebarActions({
  label,
  icon,
  actions,
}: {
  label: string;
  icon: ReactNode;
  actions: { label: string; icon?: ReactNode; open: () => void }[];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="remote-sidebar-trigger"
        aria-label={label}
        title={label}
        popoverTarget={id}
      >
        {icon}
      </button>
      <div id={id} popover="auto" className="remote-sidebar-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={(event) => {
              event.currentTarget.parentElement?.hidePopover();
              trigger.current?.focus();
              action.open();
            }}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function RemoteSidebar({
  servers,
  selected,
  back,
  select,
  add,
  importAlias,
  openCli,
}: {
  servers: Server[] | undefined;
  selected: string;
  back: () => void;
  select: (id: string) => void;
  add: () => void;
  importAlias: () => void;
  openCli: () => void;
}) {
  const [filter, setFilter] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const query = filter.trim().toLowerCase();
  const visibleServers = servers?.filter((server) =>
    `${server.name} ${server.hops.at(-1)?.host ?? ''}`.toLowerCase().includes(query),
  );
  const hasServers = Boolean(servers?.length);
  return (
    <aside id="remote-navigation" className="sidebar remote-sidebar" aria-label="服务器导航">
      <div className="remote-sidebar-top">
        <button type="button" className="nav-row" onClick={back}>
          <ArrowLeft size={16} />
          本地会话
        </button>
        <SidebarActions
          label="远端工作区更多操作"
          icon={<Ellipsis size={17} />}
          actions={[{ label: 'Agent CLI', icon: <Terminal size={15} />, open: openCli }]}
        />
      </div>
      <p className="remote-sidebar-title">远端工作区</p>
      <div className="remote-sidebar-heading">
        <h2>服务器</h2>
        {hasServers && (
          <SidebarActions
            label="服务器添加选项"
            icon={<Plus size={17} />}
            actions={[
              { label: '添加服务器', open: add },
              { label: '导入 SSH 别名', open: importAlias },
            ]}
          />
        )}
      </div>
      {hasServers && (
        <label className="remote-server-search">
          <Search size={14} />
          <input
            ref={search}
            type="search"
            aria-label="搜索服务器名称或主机"
            placeholder="搜索名称或主机"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      )}
      <div className="project-list">
        {servers?.length === 0 && (
          <div className="remote-sidebar-empty">
            <p>还没有服务器</p>
            <button type="button" className="primary" onClick={add}>
              <Plus size={16} />
              添加服务器
            </button>
            <button type="button" onClick={importAlias}>导入 SSH 别名</button>
          </div>
        )}
        {hasServers && visibleServers?.length === 0 && (
          <div className="remote-sidebar-empty">
            <p role="status">未找到匹配的服务器</p>
            <button
              type="button"
              onClick={() => {
                setFilter('');
                search.current?.focus();
              }}
            >
              清除搜索
            </button>
          </div>
        )}
        {visibleServers?.map((server) => {
          const metadata = `${server.backend === 'slurm' ? 'Slurm' : 'Linux'} · ${server.hops.at(-1)?.host}`;
          return (
            <button
              type="button"
              className={`project-row ${server.id === selected ? 'selected' : ''}`}
              key={server.id}
              aria-current={server.id === selected ? 'page' : undefined}
              title={`${server.name}\n${metadata}`}
              onClick={() => select(server.id)}
            >
              <ServerIcon size={16} />
              <span>
                <strong>{server.name}</strong>
                <small>{metadata}</small>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
