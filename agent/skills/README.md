# Jarvis Skills

Skills are structured capability definitions that extend Jarvis's behavior.

## Format

Each skill is a markdown file following the SKILL.md format:

```markdown
# Skill Name

## Trigger
When this skill should activate (regex pattern or keyword match).

## Instructions
Step-by-step instructions for executing this skill.

## Tools Required
Which tools this skill needs (shell_exec, file_read, etc).

## Example
Example input/output for this skill.
```

## Adding Skills

Drop a `.md` file in this directory following the format above. Jarvis will load all skills from this directory and include them in its system prompt when relevant.
