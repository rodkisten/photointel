"""Utilitários de logging e gerenciamento de passos para workflows."""
from contextlib import contextmanager
import itertools
import logging
import time

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

_step_counter = itertools.count(1)

@contextmanager
def auto_step(name: str):
    step_num = next(_step_counter)
    logger.info(f"\n▶ [Step {step_num}] {name}...\n")
    start = time.perf_counter()
    try:
        yield
        elapsed = time.perf_counter() - start
        logger.info(f"\n✔ [Step {step_num}] Finalizado em {elapsed:.2f}s\n")
    except Exception as e:
        logger.error(f"\n✖ [Step {step_num}] Erro: {e}\n")
        raise
