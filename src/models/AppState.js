const mongoose = require('mongoose');

const appStateSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    minimize: false,
    timestamps: true,
  }
);

module.exports = mongoose.models.AppState || mongoose.model('AppState', appStateSchema);
