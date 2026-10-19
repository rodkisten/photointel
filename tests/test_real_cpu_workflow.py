"""CPU dependency substitution preserves pins and never introduces a CUDA build."""

import importlib.util
from pathlib import Path

import pytest


def cpu_script():
    path = Path(__file__).parents[1] / "infra/scripts/real-cpu-smoke.py"
    spec = importlib.util.spec_from_file_location("real_cpu_smoke", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cpu_requirements_remove_only_gpu_wheels_and_cuda_runtime() -> None:
    original = (
        "torch==2.14.1\n"
        "torchvision==0.29.1\n"
        "cuda-toolkit[cupti]==13.2; sys_platform == 'linux'\n"
        "nvidia-cudnn-cu13==9.2\n"
        "triton==3.7\n"
        "transformers==5.10.2\n"
        "numpy==2.4; python_version >= '3.12'\n"
    )
    assert cpu_script().cpu_requirements(original) == (
        "transformers==5.10.2\nnumpy==2.4; python_version >= '3.12'\n"
    )


@pytest.mark.parametrize("requirement", ["torch>=2.6", "-e .", "--extra-index-url x"])
def test_cpu_requirements_refuse_unpinned_or_executable_options(requirement: str) -> None:
    with pytest.raises(ValueError, match="frozen requirement"):
        cpu_script().cpu_requirements(requirement)


def test_cpu_requirements_refuse_empty_selection() -> None:
    with pytest.raises(ValueError, match="Empty CPU"):
        cpu_script().cpu_requirements("torch==2.14.1\n")
