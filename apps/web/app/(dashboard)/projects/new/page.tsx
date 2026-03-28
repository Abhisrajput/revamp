'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, Check, GitBranch, Upload, FolderOpen,
  Code2, FileText, Sparkles, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/api-client';
import Link from 'next/link';

// ─── Types ─────────────────────────────────────────────────────────────────

interface PresetTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
}

interface WizardData {
  name: string;
  description: string;
  source_type: 'git' | 'upload' | 'local' | '';
  source_url: string;
  source_branch: string;
  target_stack: string;
  target_cloud: string;
  prompt_template_id: string;
}

const STEPS = [
  { label: 'Project Info', icon: FileText },
  { label: 'Codebase Source', icon: GitBranch },
  { label: 'Target Stack', icon: Code2 },
  { label: 'Prompt Template', icon: Sparkles },
  { label: 'Review', icon: Check },
];

const TARGET_STACKS = [
  { id: 'java-spring', label: 'Java / Spring Boot', icon: '☕' },
  { id: 'python-fastapi', label: 'Python / FastAPI', icon: '🐍' },
  { id: 'go', label: 'Go', icon: '🔷' },
  { id: 'node-nest', label: 'Node.js / NestJS', icon: '💚' },
  { id: 'dotnet', label: '.NET / C#', icon: '🟣' },
  { id: 'rust', label: 'Rust', icon: '🦀' },
];

const CLOUD_PROVIDERS = [
  { id: 'aws', label: 'Amazon Web Services', icon: '🟠' },
  { id: 'gcp', label: 'Google Cloud Platform', icon: '🔵' },
  { id: 'azure', label: 'Microsoft Azure', icon: '🟢' },
  { id: 'on-prem', label: 'On-Premises', icon: '🏢' },
];

const CATEGORY_COLORS: Record<string, string> = {
  Foundation: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  'Web Apps': 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  Architecture: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  Infrastructure: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
  Strategy: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
  Design: 'bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300',
};

// ─── Component ─────────────────────────────────────────────────────────────

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>({
    name: '',
    description: '',
    source_type: '',
    source_url: '',
    source_branch: 'main',
    target_stack: '',
    target_cloud: '',
    prompt_template_id: '',
  });

  // Fetch preset templates
  const { data: templates = [] } = useQuery<PresetTemplate[]>({
    queryKey: ['prompt-templates'],
    queryFn: async () => {
      const res = await apiClient.get('/prompt-templates');
      return res.data;
    },
  });

  // Create project mutation
  const createProject = useMutation({
    mutationFn: async (projectData: WizardData) => {
      const res = await apiClient.post('/projects', {
        name: projectData.name,
        description: projectData.description,
        source_type: projectData.source_type || undefined,
        source_url: projectData.source_url || undefined,
        source_branch: projectData.source_branch || 'main',
        target_stack: projectData.target_stack || undefined,
        target_cloud: projectData.target_cloud || undefined,
        prompt_template_id: projectData.prompt_template_id || undefined,
      });
      return res.data;
    },
    onSuccess: (project) => {
      router.push(`/projects/${project.id}`);
    },
  });

  const update = useCallback((patch: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...patch }));
  }, []);

  const canNext = () => {
    switch (step) {
      case 0: return data.name.trim().length > 0;
      case 1: return true; // source is optional
      case 2: return true; // target is optional
      case 3: return true; // template is optional
      case 4: return true;
      default: return false;
    }
  };

  const handleCreate = () => {
    createProject.mutate(data);
  };

  // Group templates by category
  const templatesByCategory = templates.reduce<Record<string, PresetTemplate[]>>((acc, t) => {
    if (!acc[t.category]) acc[t.category] = [];
    acc[t.category].push(t);
    return acc;
  }, {});

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link href="/projects">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
            New Project
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Set up a legacy modernization project
          </p>
        </div>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between mb-8 px-4">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const isActive = i === step;
          const isCompleted = i < step;
          return (
            <div key={s.label} className="flex items-center">
              <button
                onClick={() => i <= step && setStep(i)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-primary-600 text-white'
                    : isCompleted
                      ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 cursor-pointer'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                }`}
              >
                {isCompleted ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Icon className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                <div className={`w-8 h-px mx-1 ${i < step ? 'bg-primary-400' : 'bg-slate-300 dark:bg-slate-700'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <Card className="bg-white dark:bg-slate-800 mb-6">
        <CardContent className="p-8">
          {/* Step 0: Project Info */}
          {step === 0 && (
            <div className="space-y-6">
              <div>
                <CardTitle className="text-xl mb-1">Project Information</CardTitle>
                <CardDescription>Give your modernization project a name and description</CardDescription>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Project Name *
                  </label>
                  <Input
                    placeholder="e.g., Legacy Banking System Modernization"
                    value={data.name}
                    onChange={(e) => update({ name: e.target.value })}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Description
                  </label>
                  <textarea
                    className="flex w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-600 min-h-[100px]"
                    placeholder="Describe the legacy system you want to modernize..."
                    value={data.description}
                    onChange={(e) => update({ description: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Codebase Source */}
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <CardTitle className="text-xl mb-1">Codebase Source</CardTitle>
                <CardDescription>Where is your legacy codebase? You can skip this and add it later.</CardDescription>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  { type: 'git' as const, icon: GitBranch, label: 'Git Repository', desc: 'Clone from GitHub, GitLab, etc.' },
                  { type: 'upload' as const, icon: Upload, label: 'Upload Files', desc: 'Upload a ZIP archive' },
                  { type: 'local' as const, icon: FolderOpen, label: 'Local Path', desc: 'Point to local directory' },
                ].map(({ type, icon: Icon, label, desc }) => (
                  <button
                    key={type}
                    onClick={() => update({ source_type: data.source_type === type ? '' : type })}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      data.source_type === type
                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                    }`}
                  >
                    <Icon className={`w-6 h-6 mb-2 ${data.source_type === type ? 'text-primary-600' : 'text-slate-400'}`} />
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-50">{label}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{desc}</div>
                  </button>
                ))}
              </div>

              {data.source_type === 'git' && (
                <div className="space-y-4 pt-2">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Repository URL
                    </label>
                    <Input
                      placeholder="https://github.com/org/repo.git"
                      value={data.source_url}
                      onChange={(e) => update({ source_url: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Branch
                    </label>
                    <Input
                      placeholder="main"
                      value={data.source_branch}
                      onChange={(e) => update({ source_branch: e.target.value })}
                    />
                  </div>
                </div>
              )}

              {data.source_type === 'local' && (
                <div className="pt-2">
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Local Path
                  </label>
                  <Input
                    placeholder="/path/to/legacy/codebase"
                    value={data.source_url}
                    onChange={(e) => update({ source_url: e.target.value })}
                  />
                </div>
              )}
            </div>
          )}

          {/* Step 2: Target Stack */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <CardTitle className="text-xl mb-1">Target Stack & Cloud</CardTitle>
                <CardDescription>Choose the target technology stack and cloud provider for modernization</CardDescription>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
                  Target Technology Stack
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {TARGET_STACKS.map((stack) => (
                    <button
                      key={stack.id}
                      onClick={() => update({ target_stack: data.target_stack === stack.id ? '' : stack.id })}
                      className={`p-3 rounded-lg border-2 text-left transition-all ${
                        data.target_stack === stack.id
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                          : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                      }`}
                    >
                      <span className="text-lg">{stack.icon}</span>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-50 mt-1">{stack.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
                  Target Cloud Provider
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {CLOUD_PROVIDERS.map((cloud) => (
                    <button
                      key={cloud.id}
                      onClick={() => update({ target_cloud: data.target_cloud === cloud.id ? '' : cloud.id })}
                      className={`p-3 rounded-lg border-2 text-center transition-all ${
                        data.target_cloud === cloud.id
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                          : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                      }`}
                    >
                      <span className="text-lg">{cloud.icon}</span>
                      <div className="text-xs font-medium text-slate-900 dark:text-slate-50 mt-1">{cloud.label}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Prompt Template */}
          {step === 3 && (
            <div className="space-y-6">
              <div>
                <CardTitle className="text-xl mb-1">Prompt Template</CardTitle>
                <CardDescription>
                  Choose a curated prompt template that guides the AI through each pipeline stage.
                  You can customize prompts later in project settings.
                </CardDescription>
              </div>

              {/* No template option */}
              <button
                onClick={() => update({ prompt_template_id: '' })}
                className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                  data.prompt_template_id === ''
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                }`}
              >
                <div className="text-sm font-medium text-slate-900 dark:text-slate-50">
                  Default Prompts (No Template)
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Use the comprehensive built-in prompts for each stage
                </div>
              </button>

              {/* Templates by category */}
              {Object.entries(templatesByCategory).map(([category, catTemplates]) => (
                <div key={category}>
                  <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                    {category}
                  </h3>
                  <div className="space-y-2">
                    {catTemplates.map((template) => (
                      <button
                        key={template.id}
                        onClick={() => update({ prompt_template_id: template.id })}
                        className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                          data.prompt_template_id === template.id
                            ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                            : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                            {template.name}
                          </span>
                          <Badge className={CATEGORY_COLORS[template.category] || 'bg-slate-100 text-slate-600'}>
                            {template.category}
                          </Badge>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                          {template.description}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Step 4: Review */}
          {step === 4 && (
            <div className="space-y-6">
              <div>
                <CardTitle className="text-xl mb-1">Review & Create</CardTitle>
                <CardDescription>Review your project configuration before creating</CardDescription>
              </div>

              <div className="divide-y divide-slate-200 dark:divide-slate-700">
                {/* Name & Description */}
                <div className="pb-4">
                  <h3 className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Project</h3>
                  <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">{data.name}</p>
                  {data.description && (
                    <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{data.description}</p>
                  )}
                </div>

                {/* Source */}
                <div className="py-4">
                  <h3 className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Codebase Source</h3>
                  {data.source_type ? (
                    <div className="flex items-center gap-2">
                      <GitBranch className="w-4 h-4 text-slate-400" />
                      <span className="text-sm text-slate-900 dark:text-slate-50">
                        {data.source_type === 'git' ? data.source_url || 'Git repository' : data.source_type}
                        {data.source_branch && data.source_type === 'git' && ` (${data.source_branch})`}
                      </span>
                    </div>
                  ) : (
                    <span className="text-sm text-slate-400 italic">Not configured yet</span>
                  )}
                </div>

                {/* Target */}
                <div className="py-4">
                  <h3 className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Target</h3>
                  <div className="flex items-center gap-4">
                    {data.target_stack ? (
                      <span className="text-sm text-slate-900 dark:text-slate-50">
                        {TARGET_STACKS.find((s) => s.id === data.target_stack)?.icon}{' '}
                        {TARGET_STACKS.find((s) => s.id === data.target_stack)?.label}
                      </span>
                    ) : (
                      <span className="text-sm text-slate-400 italic">No target stack</span>
                    )}
                    {data.target_cloud && (
                      <span className="text-sm text-slate-900 dark:text-slate-50">
                        {CLOUD_PROVIDERS.find((c) => c.id === data.target_cloud)?.icon}{' '}
                        {CLOUD_PROVIDERS.find((c) => c.id === data.target_cloud)?.label}
                      </span>
                    )}
                  </div>
                </div>

                {/* Template */}
                <div className="pt-4">
                  <h3 className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Prompt Template</h3>
                  {data.prompt_template_id ? (
                    <span className="text-sm text-slate-900 dark:text-slate-50">
                      {templates.find((t) => t.id === data.prompt_template_id)?.name}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-900 dark:text-slate-50">Default Prompts</span>
                  )}
                </div>
              </div>

              {createProject.error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-sm text-red-700 dark:text-red-300">
                    Failed to create project. Please try again.
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        {step < STEPS.length - 1 ? (
          <Button
            onClick={() => setStep(step + 1)}
            disabled={!canNext()}
          >
            Next
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        ) : (
          <Button
            onClick={handleCreate}
            disabled={createProject.isPending || !data.name.trim()}
          >
            {createProject.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Create Project
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
