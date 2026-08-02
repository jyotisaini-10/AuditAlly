import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IViolationNode {
  target: string[];
  html: string;
  failureSummary: string;
}

export interface IViolationExplanation {
  plainLanguageExplanation: string;
  whyItMatters: string;
  suggestedFixCode: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  confidence: 'high' | 'medium' | 'low';
  isFallback?: boolean;
  confidenceNote?: string;
}

export interface IStoredViolation {
  id: string;
  impact?: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: IViolationNode[];
  explanation?: IViolationExplanation;
}

export interface ILlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface IScoreBreakdown {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  penalty: number;
}

export interface IScanComparison {
  previousScanId: Types.ObjectId | null;
  fixed: number;
  new: number;
  unchanged: number;
}

export interface IScan extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId | null;
  jobId?: string;
  url: string;
  scannedAt: Date;
  violationCount: number;
  incompleteCount: number;
  passesCount: number;
  scanDurationMs: number;
  violations: IStoredViolation[];
  accessibilityScore?: number;
  scoreBreakdown?: IScoreBreakdown;
  comparison?: IScanComparison;
  shareToken?: string;
  llmCostUsd?: number;
  llmReusedCount?: number;
  llm?: {
    enabled: boolean;
    mock: boolean;
    usage: ILlmUsage;
  };
  status: 'completed' | 'failed';
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const explanationSchema = new Schema<IViolationExplanation>(
  {
    plainLanguageExplanation: String,
    whyItMatters: String,
    suggestedFixCode: String,
    severity: {
      type: String,
      enum: ['critical', 'serious', 'moderate', 'minor'],
    },
    confidence: { type: String, enum: ['high', 'medium', 'low'] },
    isFallback: Boolean,
    confidenceNote: String,
  },
  { _id: false }
);

const violationSchema = new Schema<IStoredViolation>(
  {
    id: { type: String, required: true },
    impact: {
      type: String,
      enum: ['critical', 'serious', 'moderate', 'minor'],
      required: false,
      default: null,
    },
    description: String,
    help: String,
    helpUrl: String,
    tags: [String],
    nodes: [
      {
        target: [String],
        html: String,
        failureSummary: String,
        _id: false,
      },
    ],
    explanation: explanationSchema,
  },
  { _id: false }
);

const scanSchema = new Schema<IScan>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    jobId: { type: String, index: true },
    url: { type: String, required: true, index: true },
    scannedAt: { type: Date, required: true, index: true },
    violationCount: { type: Number, default: 0 },
    incompleteCount: { type: Number, default: 0 },
    passesCount: { type: Number, default: 0 },
    scanDurationMs: { type: Number, default: 0 },
    violations: [violationSchema],
    accessibilityScore: Number,
    scoreBreakdown: {
      critical: Number,
      serious: Number,
      moderate: Number,
      minor: Number,
      penalty: Number,
    },
    comparison: {
      previousScanId: { type: Schema.Types.ObjectId, ref: 'Scan', default: null },
      fixed: Number,
      new: Number,
      unchanged: Number,
    },
    shareToken: { type: String, index: true, sparse: true },
    llmCostUsd: Number,
    llmReusedCount: { type: Number, default: 0 },
    llm: {
      enabled: Boolean,
      mock: Boolean,
      usage: {
        promptTokens: Number,
        completionTokens: Number,
        totalTokens: Number,
        model: String,
      },
    },
    status: {
      type: String,
      enum: ['completed', 'failed'],
      default: 'completed',
    },
    error: String,
  },
  { timestamps: true }
);

scanSchema.index({ userId: 1, scannedAt: -1 });
scanSchema.index({ userId: 1, url: 1, scannedAt: -1 });

export const Scan = mongoose.model<IScan>('Scan', scanSchema);
