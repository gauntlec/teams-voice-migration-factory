import { Dropdown, Field, Option, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { UNANSWERED_DELAYS, defaultUnanswered, setUnansweredChoice, type CallForwardingSettings } from '@tvmf/shared';
import { useAuth } from '../auth';
import { UpnAutocomplete } from './UpnAutocomplete';

const useStyles = makeStyles({
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', ...shorthands.gap('8px') },
  stack: { display: 'flex', flexDirection: 'column', ...shorthands.gap('6px') },
  hint: { color: tokens.colorNeutralForeground3 },
  warn: { color: tokens.colorPaletteRedForeground1 },
  target: { minWidth: '240px' },
});

type Choice = 'Voicemail' | 'None' | 'SingleTarget' | 'MyDelegates' | 'Group';
const LABEL: Record<Choice, string> = {
  Voicemail: 'Go to voicemail',
  None: 'Do nothing (keep ringing)',
  SingleTarget: 'Forward to a person or number',
  MyDelegates: 'Forward to delegates',
  Group: 'Forward to call group',
};

/**
 * "If a call is unanswered", for Site Data's and Design & Build's user dialogs. The value is the row's call_forwarding as JSON text; only
 * its `unanswered` part is touched. Teams' own default is to do nothing, so with voicemail on this starts on voicemail after 20 seconds.
 */
export function UnansweredCallEditor({ value, voicemailOn, onChange }: { value: string; voicemailOn: boolean; onChange: (text: string) => void }) {
  const s = useStyles();
  const { activeTenantId } = useAuth();
  let settings: CallForwardingSettings = {};
  try {
    settings = (JSON.parse(value || '{}') as CallForwardingSettings | null) ?? {};
  } catch {
    settings = {};
  }
  const isDefault = !settings.unanswered;
  const current = settings.unanswered ?? defaultUnanswered(voicemailOn);
  const choice: Choice = current.enabled ? (current.targetType ?? 'Voicemail') : 'None';
  const delay = current.delaySeconds ?? 20;
  const save = (next: NonNullable<CallForwardingSettings['unanswered']>) => onChange(JSON.stringify(setUnansweredChoice(settings, next, voicemailOn)));
  const pick = (c: Choice) => save(c === 'None' ? { enabled: false } : { enabled: true, delaySeconds: delay, targetType: c, ...(c === 'SingleTarget' ? { target: current.target ?? '' } : {}) });
  return (
    <div className={s.stack}>
      <div className={s.row}>
        <Dropdown aria-label="If a call is unanswered" value={LABEL[choice]} selectedOptions={[choice]} onOptionSelect={(_, d) => d.optionValue && pick(d.optionValue as Choice)}>
          {(Object.keys(LABEL) as Choice[]).map((c) => (
            <Option key={c} value={c} text={LABEL[c]} disabled={c === 'Voicemail' && !voicemailOn}>
              {LABEL[c]}
            </Option>
          ))}
        </Dropdown>
        {choice !== 'None' && (
          <Field label="After">
            <Dropdown value={`${delay} seconds`} selectedOptions={[String(delay)]} onOptionSelect={(_, d) => save({ ...current, delaySeconds: Number(d.optionValue) || 20 })}>
              {UNANSWERED_DELAYS.map((n) => (
                <Option key={n} value={String(n)} text={`${n} seconds`}>
                  {`${n} seconds`}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}
        {choice === 'SingleTarget' && (
          <Field label="Person or number" required>
            <UpnAutocomplete tenantId={activeTenantId ?? ''} value={current.target ?? ''} onChange={(target) => save({ ...current, target })} className={s.target} />
          </Field>
        )}
      </div>
      {choice === 'Voicemail' && !voicemailOn && <Text size={200} className={s.warn}>Voicemail is off for this user, so this can't work. Turn voicemail on or choose something else.</Text>}
      {isDefault && voicemailOn && <Text size={200} className={s.hint}>The default. If Teams already has another rule for this user, it's left as it is unless you change it here.</Text>}
    </div>
  );
}
