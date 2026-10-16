import { AlertTriangle, Loader2, Send, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useApp } from '../../context/AppContext';
import { useToast } from '../../context/ToastContext';
import { api, errorText } from '../../lib/api';
import type { AddAlbumInput, AddResponse, AlbumResult, PreflightResponse } from '../../../shared/types';

interface Props {
  selected: AlbumResult[];
  onClear: () => void;
  onSent: (addedMbids: string[]) => void;
}

function toInput(a: AlbumResult): AddAlbumInput {
  return {
    mbid: a.mbid,
    title: a.title,
    artistMbid: a.artistMbid,
    artistName: a.artistName,
    year: a.year,
    primaryType: a.primaryType,
    secondaryTypes: a.secondaryTypes,
    releaseMbid: a.releaseMbid ?? null,
  };
}

/** Sticky bottom action bar: profiles + "Send X Albums to Lidarr" with the metadata-profile trap guard. */
export function SendBar({ selected, onClear, onSent }: Props) {
  const { settings, profiles, profilesError, openSettings, setBottomInset, bumpActivity, bumpLibrary } = useApp();
  const toast = useToast();
  const barRef = useRef<HTMLDivElement>(null);
  const [rootFolder, setRootFolder] = useState('');
  const [qualityId, setQualityId] = useState('');
  const [metadataId, setMetadataId] = useState('');
  const [monitorAll, setMonitorAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<PreflightResponse | null>(null);

  // Defaults: Settings values, else the first option Lidarr reports.
  useEffect(() => {
    if (!profiles) return;
    setRootFolder((v) => v || settings?.rootFolderPath || profiles.rootFolders[0]?.path || '');
    setQualityId((v) => v || String(settings?.qualityProfileId ?? profiles.qualityProfiles[0]?.id ?? ''));
    setMetadataId((v) => v || String(settings?.metadataProfileId ?? profiles.metadataProfiles[0]?.id ?? ''));
  }, [profiles, settings?.rootFolderPath, settings?.qualityProfileId, settings?.metadataProfileId]);

  const visible = selected.length > 0;

  useLayoutEffect(() => {
    if (!visible) {
      setBottomInset(0);
      return;
    }
    const el = barRef.current;
    if (!el) return;
    const update = () => setBottomInset(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      setBottomInset(0);
    };
  }, [visible, setBottomInset]);

  if (!visible) return null;

  const send = async (usePermissiveProfile: boolean) => {
    setConflict(null);
    setBusy(true);
    try {
      const res = await api.post<AddResponse>('/api/lidarr/add', {
        albums: selected.map(toInput),
        rootFolderPath: rootFolder,
        qualityProfileId: Number(qualityId),
        metadataProfileId: Number(metadataId),
        monitorEntireArtist: monitorAll,
        usePermissiveProfile,
      });
      const ok = res.results.filter((r) => r.ok);
      const failed = res.results.filter((r) => !r.ok);
      if (ok.length) {
        const newArtists = ok.filter((r) => r.action === 'added_artist').length;
        const details = [
          `${ok.length} artist${ok.length === 1 ? '' : 's'}${newArtists ? ` (${newArtists} new)` : ''}`,
          res.editionsSet ? `standard edition set for ${res.editionsSet}` : null,
          res.searchPending
            ? 'new artists are searched as soon as Lidarr finishes importing them (~1 min, see the activity pill)'
            : 'searching now',
        ].filter(Boolean);
        toast.success(`Sent ${res.addedMbids.length} album${res.addedMbids.length === 1 ? '' : 's'} to Lidarr`, details.join(' · '));
      }
      for (const f of failed) toast.error(`${f.artistName}: not sent`, f.error ?? undefined);
      if (res.warnings.length) toast.warning('Heads up', res.warnings.slice(0, 4).join('\n'));
      onSent(res.addedMbids);
      bumpActivity();
      bumpLibrary();
    } catch (err) {
      toast.error('Could not send to Lidarr', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!settings?.lidarrConfigured) {
      toast.error('Lidarr is not configured', 'Add your Lidarr URL and API key first.');
      openSettings('lidarr');
      return;
    }
    if (!rootFolder || !qualityId || !metadataId) {
      toast.error('Choose a root folder, quality profile and metadata profile.');
      return;
    }
    setBusy(true);
    try {
      const pre = await api.post<PreflightResponse>('/api/lidarr/preflight', {
        albums: selected.map(toInput),
        metadataProfileId: Number(metadataId),
      });
      if (pre.conflicts.length > 0) {
        setConflict(pre);
        setBusy(false);
        return;
      }
    } catch (err) {
      toast.error('Lidarr pre-check failed', errorText(err));
      setBusy(false);
      return;
    }
    await send(false);
  };

  const n = selected.length;
  const artistCount = new Set(selected.map((a) => a.artistMbid)).size;

  return (
    <>
      <div
        ref={barRef}
        className="fixed inset-x-0 bottom-0 z-30 animate-slide-up border-t border-violet-500/30 bg-zinc-950/95 shadow-[0_-12px_40px_rgba(0,0,0,0.5)] backdrop-blur-md"
      >
        <div className="mx-auto flex max-w-7xl flex-wrap items-end gap-3 px-4 py-3">
          <div className="flex items-center gap-2 self-center">
            <button className="btn-ghost p-1.5" onClick={onClear} aria-label="Clear selection" title="Clear selection">
              <X className="h-4 w-4" />
            </button>
            <div>
              <p className="text-sm font-semibold text-zinc-100">{n} selected</p>
              <p className="text-[11px] text-zinc-500">
                {artistCount} artist{artistCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          {profiles ? (
            <>
              <label className="min-w-[10rem] flex-1">
                <span className="label">Root Folder</span>
                <select className="select py-1.5" value={rootFolder} onChange={(e) => setRootFolder(e.target.value)}>
                  {profiles.rootFolders.map((r) => (
                    <option key={r.id} value={r.path}>
                      {r.path}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-[9rem] flex-1">
                <span className="label">Quality Profile</span>
                <select className="select py-1.5" value={qualityId} onChange={(e) => setQualityId(e.target.value)}>
                  {profiles.qualityProfiles.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-[9rem] flex-1">
                <span className="label">Metadata Profile</span>
                <select className="select py-1.5" value={metadataId} onChange={(e) => setMetadataId(e.target.value)}>
                  {profiles.metadataProfiles.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p className="flex-1 self-center text-xs text-zinc-500">
              {settings?.lidarrConfigured ? (profilesError ?? 'Loading Lidarr profiles…') : 'Connect Lidarr in Settings to send albums.'}
            </p>
          )}
          <label className="flex cursor-pointer items-center gap-2 self-center text-xs text-zinc-300" title="Monitor every album by these artists">
            <input type="checkbox" className="checkbox" checked={monitorAll} onChange={(e) => setMonitorAll(e.target.checked)} />
            Monitor Entire Artist
          </label>
          <button className="btn-primary self-center px-4 py-2" onClick={start} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send {n} Album{n === 1 ? '' : 's'} to Lidarr
          </button>
        </div>
      </div>

      <Modal
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" /> Metadata profile would skip some albums
          </span>
        }
        width="max-w-lg"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConflict(null)}>
              Cancel
            </button>
            <button className="btn-secondary" onClick={() => void send(false)}>
              Send anyway
            </button>
            {conflict?.suggestedProfile && (
              <button className="btn-primary" onClick={() => void send(true)}>
                Use “{conflict.suggestedProfile.name}”
              </button>
            )}
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Lidarr silently ignores albums whose release type isn't allowed by the artist's metadata profile:
        </p>
        <ul className="mt-3 max-h-60 space-y-1.5 overflow-y-auto">
          {conflict?.conflicts.map((c) => (
            <li key={c.mbid} className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs">
              <span className="font-medium text-zinc-200">
                {c.artistName} – {c.title}
              </span>
              <span className="block text-zinc-500">
                “{c.profileName}” doesn't allow: {c.missingTypes.join(', ')}
                {c.existingArtist ? ' (existing artist)' : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-zinc-400">
          {conflict?.suggestedProfile
            ? `Spin Seek can use the “${conflict.suggestedProfile.name}” profile for just these artists so nothing is dropped.`
            : 'No metadata profile in Lidarr allows these types. Create a permissive profile in Lidarr → Settings → Profiles, or send anyway.'}
        </p>
      </Modal>
    </>
  );
}
