'use client';

import { memo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Code2, Layers, Globe, Wrench, Brain, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@revamp/ui/components/badge';
import { Button } from '@revamp/ui/components/button';
import { Card } from '@revamp/ui/components/card';
import { apiClient } from '@/lib/api-client';

interface Skill {
  id: string;
  name: string;
  slug: string;
  description?: string;
  category: string;
  knowledge: string;
  tags: string[];
  version: number;
  created_at: string;
}

const CATEGORY_CONFIG: Record<string, { icon: typeof Code2; color: string; bg: string }> = {
  language: { icon: Code2, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/20' },
  framework: { icon: Layers, color: 'text-purple-500', bg: 'bg-purple-50 dark:bg-purple-950/20' },
  pattern: { icon: Brain, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/20' },
  domain: { icon: Globe, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-950/20' },
  tool: { icon: Wrench, color: 'text-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-950/20' },
};

export const SkillsView = memo(function SkillsView() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ skills: Skill[] }>({
    queryKey: ['agent-skills'],
    queryFn: async () => (await apiClient.get('/agent-skills')).data,
    staleTime: 15_000,
  });

  const deleteSkill = useMutation({
    mutationFn: async (id: string) => (await apiClient.delete(`/agent-skills/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-skills'] }),
  });

  const skills = data?.skills || [];
  const grouped = skills.reduce((acc, s) => {
    (acc[s.category] = acc[s.category] || []).push(s);
    return acc;
  }, {} as Record<string, Skill[]>);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Skills Library</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Reusable knowledge modules assignable to agents</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)} className="gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          New Skill
        </Button>
      </div>

      {showCreate && <CreateSkillForm onClose={() => setShowCreate(false)} />}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => <div key={i} className="h-32 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />)}
        </div>
      ) : skills.length === 0 ? (
        <Card className="bg-white dark:bg-slate-800 p-12 text-center">
          <BookOpen className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
          <p className="text-sm text-slate-500">No skills defined yet</p>
          <p className="text-xs text-slate-400 mt-1">Create skills like "React Patterns", "COBOL Analysis", "API Design"</p>
        </Card>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([category, catSkills]) => {
            const cfg = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.tool;
            const Icon = cfg.icon;
            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon className={cn('w-4 h-4', cfg.color)} />
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 capitalize">{category}</h3>
                  <Badge className="text-[9px] bg-slate-100 dark:bg-slate-700 text-slate-500">{catSkills.length}</Badge>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {catSkills.map(skill => {
                    const isExpanded = expandedId === skill.id;
                    return (
                      <div key={skill.id} className={cn(
                        'rounded-xl border p-4 transition-all duration-300 cursor-pointer',
                        'bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700/60',
                        'hover:shadow-[0_4px_20px_rgba(0,0,0,0.04)]',
                      )} onClick={() => setExpandedId(isExpanded ? null : skill.id)}>
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <div className={cn('p-1.5 rounded-md', cfg.bg)}>
                              <Icon className={cn('w-3.5 h-3.5', cfg.color)} />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{skill.name}</p>
                              <p className="text-[10px] text-slate-400 font-mono">{skill.slug}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                          </div>
                        </div>
                        {skill.description && (
                          <p className="text-[11px] text-slate-500 mt-2 line-clamp-2">{skill.description}</p>
                        )}
                        {skill.tags && Array.isArray(skill.tags) && skill.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {skill.tags.slice(0, 4).map((tag: string, i: number) => (
                              <Badge key={i} className="text-[8px] px-1 py-0 bg-slate-100 dark:bg-slate-700 text-slate-500">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {isExpanded && (
                          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700/50">
                            <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">Knowledge</p>
                            <pre className="text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap font-mono">
                              {skill.knowledge}
                            </pre>
                            <div className="flex justify-end mt-2">
                              <button onClick={(e) => { e.stopPropagation(); deleteSkill.mutate(skill.id); }}
                                className="text-[10px] text-red-500 hover:text-red-600 flex items-center gap-1">
                                <Trash2 className="w-3 h-3" /> Delete
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

function CreateSkillForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('pattern');
  const [knowledge, setKnowledge] = useState('');
  const [tags, setTags] = useState('');

  const create = useMutation({
    mutationFn: async () => (await apiClient.post('/agent-skills', {
      name, description, category, knowledge,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    })).data,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['agent-skills'] }); onClose(); },
  });

  return (
    <Card className="bg-white dark:bg-slate-800 p-5 border-primary-200 dark:border-primary-800">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">Create Skill</h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="React Patterns"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
        </div>
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Category</label>
          <select value={category} onChange={e => setCategory(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200">
            <option value="language">Language</option>
            <option value="framework">Framework</option>
            <option value="pattern">Pattern</option>
            <option value="domain">Domain</option>
            <option value="tool">Tool</option>
          </select>
        </div>
      </div>
      <div className="mb-4">
        <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this skill teaches agents"
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
      </div>
      <div className="mb-4">
        <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Knowledge (system prompt fragment)</label>
        <textarea value={knowledge} onChange={e => setKnowledge(e.target.value)} rows={4} placeholder="You are an expert in React component patterns..."
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-mono" />
      </div>
      <div className="mb-4">
        <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Tags (comma separated)</label>
        <input value={tags} onChange={e => setTags(e.target.value)} placeholder="react, hooks, typescript"
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!name.trim() || !knowledge.trim() || create.isPending}>
          {create.isPending ? 'Creating...' : 'Create Skill'}
        </Button>
      </div>
    </Card>
  );
}
