for fnm_dir in "$FNM_DIR" "$HOME/.local/share/fnm" "$HOME/.fnm"; do
  if [ -n "$fnm_dir" ] && [ -x "$fnm_dir/fnm" ]; then
    PATH="$fnm_dir:$PATH"
    break
  fi
done
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)" >/dev/null 2>&1 || true
  fnm use --install-if-missing >/dev/null 2>&1 || true
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use >/dev/null 2>&1 || true
fi
