# Two-line prompt, narrow-screen friendly, no Nerd Fonts, no git status scan.
# Line 1: directory, Git branch, last-command error (when applicable).
# Line 2: small command marker. No RPROMPT that overlaps iPhone keyboards.

autoload -Uz vcs_info add-zsh-hook
zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:git:*' formats '%F{magenta}git:%b%f'
zstyle ':vcs_info:git:*' actionformats '%F{yellow}git:%b:%a%f'
zstyle ':vcs_info:git:*' check-for-changes false

function rod_mobile_precmd() {
  local previous_status=$?
  vcs_info
  if (( previous_status != 0 )); then
    ROD_MOBILE_EXIT=" %F{red}✗${previous_status}%f"
  else
    ROD_MOBILE_EXIT=''
  fi
}

add-zsh-hook precmd rod_mobile_precmd
setopt PROMPT_SUBST
PROMPT='%F{cyan}%~%f ${vcs_info_msg_0_}${ROD_MOBILE_EXIT}
%F{green}❯%f '
RPROMPT=''
