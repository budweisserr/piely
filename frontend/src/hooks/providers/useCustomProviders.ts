import { useState } from "react";
import { TYPE_PROVIDER } from "@/types";
import { AI_PROVIDERS, SPEECH_TO_TEXT_PROVIDERS } from "@/config";
import { useApp } from "@/contexts";
import { customProviderStore, validateCurl } from "@/lib";
import type { ProviderKind } from "@/lib";

export type { ProviderKind } from "@/lib";

/** The add/edit/delete form state for custom AI and STT providers. */
export function useCustomProviders(kind: ProviderKind) {
  const isStt = kind === "stt";
  const builtinProviders = isStt ? SPEECH_TO_TEXT_PROVIDERS : AI_PROVIDERS;
  const store = customProviderStore(kind);
  const getCustom = store.get;
  const addCustom = store.add;
  const updateCustom = store.update;
  const removeCustom = store.remove;

  const { loadData } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [formData, setFormData] = useState<TYPE_PROVIDER>({
    id: "",
    streaming: false,
    responseContentPath: "",
    isCustom: true,
    curl: "",
  });

  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleEdit = (providerId: string) => {
    const customProviders = getCustom();
    const provider = customProviders.find((p) => p.id === providerId);
    if (!provider) return;

    setFormData({
      ...provider,
    });
    setEditingProvider(providerId);
    setShowForm(!showForm);
    setErrors({});
  };

  const handleAutoFill = (providerId: string) => {
    const provider = builtinProviders.find((p) => p.id === providerId);
    if (!provider) return;

    setFormData({
      ...provider,
      curl: provider.curl,
    });

    setErrors({});
  };

  const handleDelete = (providerId: string) => {
    setDeleteConfirm(providerId);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;

    try {
      const success = removeCustom(deleteConfirm);
      if (success) {
        setDeleteConfirm(null);
        loadData(); // Refresh data
      }
    } catch (error) {
      console.error("Error deleting custom provider:", error);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirm(null);
  };

  const handleSave = async () => {
    // Validate form
    const newErrors: { [key: string]: string } = {};

    const localWhisper = formData.curl.trim().startsWith("whisper-cli");
    if (!formData.curl.trim()) {
      newErrors.curl = "Curl command is required";
    } else if (isStt && !formData.curl.includes("{{AUDIO}}")) {
      newErrors.curl = "cURL command must contain {{AUDIO}}.";
    } else if (!localWhisper) {
      // A local whisper command is not curl and is run on-device instead;
      // everything else goes through the curl parser.
      const validation = validateCurl(formData.curl, isStt ? [] : ["TEXT"]);
      if (!validation.isValid) {
        newErrors.curl = validation.message || "";
      }
    }

    if (!formData.responseContentPath?.trim()) {
      newErrors.responseContentPath = "Response content path is required";
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      return;
    }

    const emptyForm: TYPE_PROVIDER = {
      id: "",
      streaming: false,
      responseContentPath: "",
      isCustom: true,
      curl: "",
    };

    try {
      if (editingProvider) {
        // Update existing provider
        const success = updateCustom(editingProvider, {
          curl: formData.curl,
          streaming: isStt ? false : formData.streaming,
          responseContentPath: formData.responseContentPath,
        });

        if (success) {
          setEditingProvider(null);
          setShowForm(false);
          setFormData(emptyForm);
          loadData(); // Refresh data
        }
      } else {
        // Create new provider
        const saved = addCustom({
          curl: formData.curl,
          streaming: isStt ? false : formData.streaming,
          responseContentPath: formData.responseContentPath,
        });
        if (saved) {
          setShowForm(false);
          setFormData(emptyForm);
          loadData(); // Refresh data
        }
      }
    } catch (error) {
      console.error("Error saving custom provider:", error);
    }
  };

  return {
    errors,
    setErrors,
    showForm,
    setShowForm,
    editingProvider,
    setEditingProvider,
    deleteConfirm,
    formData,
    setFormData,
    handleSave,
    handleAutoFill,
    handleEdit,
    handleDelete,
    confirmDelete,
    cancelDelete,
  };
}
