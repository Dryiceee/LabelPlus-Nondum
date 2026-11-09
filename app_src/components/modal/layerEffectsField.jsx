import React from "react";
import PropTypes from "prop-types";
import { FiChevronDown, FiChevronRight, FiX } from "react-icons/fi";

import { locale, nativeAlert, getActiveLayerText } from "../../utils";
import { ADDABLE, FIELDS, colorHex, effectsFromLayer, fieldValue, newEffect, withColor, withField } from "../../labelplus/layerEffects";

const effectName = (key) => locale["lpFx_" + key] || key;
const fieldName = (key) => locale["lpFxField_" + key] || key;

// The layer styles of a style, folded by default: the editor is long already
const LayerEffectsField = ({ effects, onChange }) => {
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState("");
  const list = effects || [];
  const update = (index, desc) => onChange(list.map((effect, at) => (at === index ? { key: effect.key, desc } : effect)));

  const readLayer = () => {
    getActiveLayerText((data) => {
      if (!data || !data.textProps) {
        nativeAlert(locale.errorNoTextLayer, locale.errorTitle, true);
        return;
      }
      onChange(effectsFromLayer(data.layerEffects));
    });
  };

  return (
    <div className="field hostBrdTopContrast lp-fx">
      <button type="button" className="lp-fx-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
        <span className="field-label">{locale.lpFxTitle}</span>
        <span className="lp-fx-count">{list.length ? list.map((effect) => effectName(effect.key)).join("、") : locale.lpFxNone}</span>
      </button>
      {open ? (
        <div className="lp-fx-body">
          <div className="field-descr">{locale.lpFxHint}</div>
          {list.map((effect, index) => (
            <div className="lp-fx-item hostBrdContrast" key={index}>
              <div className="lp-fx-head">
                <label className="topcoat-checkbox">
                  <input type="checkbox" checked={effect.desc.enabled !== false} onChange={(event) => update(index, { ...effect.desc, enabled: event.target.checked })} />
                  <div className="topcoat-checkbox__checkmark"></div>
                  <span>{effectName(effect.key)}</span>
                </label>
                <button type="button" className="lp-fx-remove" title={locale.delete} aria-label={locale.delete} onClick={() => onChange(list.filter((item, at) => at !== index))}>
                  <FiX size={13} />
                </button>
              </div>
              <div className="lp-fx-fields">
                {colorHex(effect.desc) ? (
                  <label>
                    <span>{fieldName("color")}</span>
                    <input type="color" value={colorHex(effect.desc)} onChange={(event) => update(index, withColor(effect.desc, event.target.value))} />
                  </label>
                ) : null}
                {FIELDS.filter((field) => fieldValue(effect.desc, field.key) !== null).map((field) => (
                  <label key={field.key}>
                    <span>{fieldName(field.key)}</span>
                    <input
                      type="number"
                      className="topcoat-text-input"
                      value={fieldValue(effect.desc, field.key)}
                      onChange={(event) => {
                        const number = parseFloat(event.target.value);
                        if (isFinite(number)) update(index, withField(effect.desc, field.key, number));
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="lp-fx-actions">
            <select className="topcoat-textarea" value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">{locale.lpFxAdd}</option>
              {ADDABLE.map((key) => <option key={key} value={key}>{effectName(key)}</option>)}
            </select>
            <button type="button" className="topcoat-button" disabled={!adding} onClick={() => { onChange(list.concat(newEffect(adding))); setAdding(""); }}>{locale.lpReplaceAdd}</button>
            <button type="button" className="topcoat-button" onClick={readLayer}>{locale.lpFxFromLayer}</button>
            <button type="button" className="topcoat-button" disabled={!list.length} onClick={() => onChange([])}>{locale.lpFxClear}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

LayerEffectsField.propTypes = {
  effects: PropTypes.array,
  onChange: PropTypes.func.isRequired,
};

export default LayerEffectsField;
